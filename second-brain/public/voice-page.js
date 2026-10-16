/**
 * The rest of the page: prices, models, folders, the work list, skills, and startup.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

// What the user can ask Tiny to do, and the pose for it.
const TINY_MOVES = [
  [/\b(?:dance|dancing|boogie)\b/, "dancing"],
  [/\bwave\b/, "hand_wave"],
  [/\bdrink\b.*\bcoffee\b|\bcoffee break\b/, "coffeedrink"],
  [/\b(?:boba|bubble tea)\b/, "bobbateadrink"],
  [/\bcelebrate\b/, "celebration"],
];

/**
 * "Can you dance?" or "Tiny, wave" makes Tiny do that move for a few seconds.
 * Only short requests count, so "add the dance class to my calendar" is left alone.
 * Returns the pose, or "".
 */
/** "Open a terminal" or "close the terminal" (terminal.js), done here without asking a model. */
function runTerminalAsk(question) {
  const ask = window.brainTerminal?.intent(question);
  if (!ask) return false;
  if (ask === "open") window.brainTerminal.openShell();
  else window.brainTerminal.closeShell();
  addBubble("assistant", ask === "open" ? "The terminal is open at the bottom of the page." : "Closed the terminal.");
  setStatus(listenStatus());
  return true;
}

function playTinyMove(text) {
  const q = String(text || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!q || q.split(" ").length > 8) return "";
  if (!/^(?:hey )?(?:tiny )?(?:(?:can|could|will|would) (?:you|u)|please|show me|let's|let us|do a|dance|wave|drink|celebrate|have a (?:coffee|boba|bubble))\b/.test(q)) return "";
  const move = TINY_MOVES.find(([pattern]) => pattern.test(q));
  if (!move) return "";
  const activity = `move-${move[1]}`;
  setActivity(activity);
  setTimeout(() => capsule.dataset.activity === activity && setActivity(""), 6000);
  return move[1];
}

function flashSaved() {
  setActivity("saved");
  setTimeout(() => capsule.dataset.activity === "saved" && setActivity(""), 2500);
}
function setBusy(busy) { talkBtn.disabled = busy; }

function waitForIceGathering(peer, timeoutMs) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    peer.addEventListener("icegatheringstatechange", onChange);
    setTimeout(done, timeoutMs);
  });
}

function safeParse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

function humanError(err) {
  const msg = err?.message || String(err);
  if (/Permission|NotAllowed/i.test(msg)) return "Microphone permission denied. Allow the mic for this window.";
  if (/NotFound|DevicesNotFound|Overconstrained/i.test(msg)) return "That microphone is not connected. Pick Local or iPhone again.";
  if (/OPENAI_API_KEY|Missing/i.test(msg)) return "The API key is missing from the .env file.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "The voice app is not running. Start it, then press Start talking again.";
  return msg;
}

/** Models that cannot hear need voice control to read the answer aloud. */
function needsVoiceControl(model) {
  return Boolean(model) && !model.hears;
}

function selectedModel() {
  return catalog?.models.find((model) => model.id === modelSelect.value) || null;
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

function shortPath(folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  return parts.slice(-2).join(" / ");
}

/** Add one reply's tokens onto the running total for this whole call. */
function addResponseUsage(response) {
  const usage = response?.usage;
  if (!usage) return;
  const id = response.id || "";
  if (id && countedResponses.has(id)) return;
  if (id) countedResponses.add(id);

  const inputDetails = usage.input_token_details || usage.input_tokens_details || {};
  const outputDetails = usage.output_token_details || usage.output_tokens_details || {};
  const cached = inputDetails.cached_tokens_details || {};

  chat.input += usage.input_tokens || 0;
  chat.output += usage.output_tokens || 0;
  chat.thinking += outputDetails.reasoning_tokens || 0;
  chat.textIn += inputDetails.text_tokens || 0;
  chat.audioIn += inputDetails.audio_tokens || 0;
  chat.cachedTextIn += cached.text_tokens || 0;
  chat.cachedAudioIn += cached.audio_tokens || 0;
  chat.textOut += outputDetails.text_tokens || 0;
  chat.audioOut += outputDetails.audio_tokens || 0;
  renderChat();
}

function voiceTokenPrice(model) {
  if (!model) return 0;
  const textIn = Math.max(0, chat.textIn - chat.cachedTextIn);
  const audioIn = Math.max(0, chat.audioIn - chat.cachedAudioIn);
  let usd = 0;
  if (model.audioInputPerMillion) {
    usd += (textIn / 1e6) * model.inputPerMillion;
    usd += (chat.cachedTextIn / 1e6) * model.cachedInputPerMillion;
    usd += (audioIn / 1e6) * model.audioInputPerMillion;
    usd += (chat.cachedAudioIn / 1e6) * model.audioCachedInputPerMillion;
    usd += (chat.textOut / 1e6) * model.outputPerMillion;
    usd += (chat.audioOut / 1e6) * model.audioOutputPerMillion;
    return usd;
  }
  return (chat.input / 1e6) * model.inputPerMillion + (chat.output / 1e6) * model.outputPerMillion;
}

function chatPrice(model) {
  if (!model) return 0;
  if (model.hears) return voiceTokenPrice(model);
  const ears = catalog?.models.find((item) => item.id === "gpt-realtime-2.1-mini");
  const brain =
    (chat.brainInput / 1e6) * model.inputPerMillion +
    (chat.brainOutput / 1e6) * model.outputPerMillion;
  return brain + voiceTokenPrice(ears);
}

/** Time from the end of the question to the first spoken word. */
function markAnswerStarted() {
  if (!questionEndedAt) return;
  answerWaits.push(performance.now() - questionEndedAt);
  questionEndedAt = 0;
  renderWaits();
}

function renderWaits() {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const total = answerWaits.reduce((sum, ms) => sum + ms, 0);
  lastWaitEl.textContent = answerWaits.length ? seconds(answerWaits.at(-1)) : "–";
  avgWaitEl.textContent = answerWaits.length ? seconds(total / answerWaits.length) : "–";
  avgWaitEl.parentElement.title = `Average over ${answerWaits.length} answer${answerWaits.length === 1 ? "" : "s"} this call`;
}

function renderChat() {
  const model = selectedModel();
  const usd = chatPrice(model);
  const shownIn = chat.input + chat.brainInput;
  const shownOut = chat.output + chat.brainOutput;
  inTokensEl.textContent = shownIn.toLocaleString();
  outTokensEl.textContent = shownOut.toLocaleString();
  thinkTokensEl.textContent = chat.thinking.toLocaleString();
  chatPriceEl.textContent = formatUsd(usd);
  const bits = [`${shownIn.toLocaleString()} input`, `${shownOut.toLocaleString()} output`];
  if (chat.audioIn || chat.audioOut) {
    bits.push(`${chat.audioIn.toLocaleString()} of the input was audio`);
    bits.push(`${chat.audioOut.toLocaleString()} of the output was audio`);
  }
  if (chat.thinking) bits.push(`${chat.thinking.toLocaleString()} thinking tokens are already inside the output`);
  breakdownEl.textContent = `Whole chat so far: ${bits.join(" · ")}. Total ${formatUsd(usd)}. A new call starts the count over.`;
}

function showRates() {
  const model = selectedModel();
  if (!model) {
    ratesEl.textContent = "Pick a model to see its price.";
    return;
  }
  const audio = model.local
    ? " The written answer is free on this Mac. Listening is free too. The Kokoro voice speaks it on this Mac, so nothing goes to OpenAI."
    : model.audioInputPerMillion
    ? ` Audio is ${formatRate(model.audioInputPerMillion)} in and ${formatRate(model.audioOutputPerMillion)} out per million tokens.`
    : " Listening stays on this Mac, so that part is free. Voice control only speaks the answer.";
  ratesEl.textContent = `${model.label}: text ${formatRate(model.inputPerMillion)} in and ${formatRate(model.outputPerMillion)} out per million tokens.${audio} ${model.blurb} Change the model or thinking before you press Start talking. That choice stays for the whole chat.`;
}

function fillReasoning() {
  const model = selectedModel();
  const previous = reasoningSelect.value;
  reasoningSelect.replaceChildren();
  if (!model || !catalog) return;
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
    option.textContent = model.label;
    if (model.id === defaultModelId) option.selected = true;
    modelSelect.append(option);
  }
  // Opening the page starts on the Hey brain (Claude). Gemini Live is still in the list if you pick it for this call.
  if (selectedModel()?.gemini) {
    const heyModel = catalog.models.find((model) => model.id === defaultModelId && !model.gemini)
      || catalog.models.find((model) => !model.gemini && !model.hears);
    if (heyModel) modelSelect.value = heyModel.id;
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

let folderSnapshot = [];

function pushInstructions(text) {
  if (!text || !dc || dc.readyState !== "open") return;
  sendEvent({
    type: "session.update",
    session: { type: "realtime", instructions: text },
  });
}

function fillFolders(state) {
  folderSnapshot = state.folders || [];
  folderList.replaceChildren();
  if (!folderSnapshot.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No folders yet. Add one below.";
    folderList.append(empty);
    return;
  }
  for (const folder of folderSnapshot) {
    const row = document.createElement("label");
    row.className = "folder-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = folder.selected;
    box.setAttribute("aria-label", `Use ${folder.name}`);
    box.addEventListener("change", () => {
      const paths = folderSnapshot
        .filter((item) => (item.path === folder.path ? box.checked : item.selected))
        .map((item) => item.path);
      chooseFolders(paths);
    });
    const name = document.createElement("span");
    name.textContent = shortPath(folder.path);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-btn small";
    remove.textContent = "Remove";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeFolder(folder.path);
    });
    row.append(box, name, remove);
    folderList.append(row);
  }
  pushInstructions(state.instructions);
}

// Saved jobs, ideas, and the last conversation. Loaded once before the first question.
let flashes = [];
let chatRestored = false;
let deskView = { jobs: [], suggestions: [], memory: {} };

function showFlash(card) {
  if (!card) return;
  flashes.unshift(card);
  flashes = flashes.slice(0, 3);
  renderDesk();
}

function persistChat() {
  fetch("/desk/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memory: chatMemory, turns: chatTurns }),
  }).then(async (response) => {
    if (!response.ok) throw new Error("Could not save the conversation.");
    const data = await response.json();
    if (data?.jobs) {
      deskView = data;
      renderDesk();
    }
  }).catch((err) => {
    console.error("Failed while saving the conversation:", err);
  });
}

function forgetSavedChat() {
  fetch("/desk/memory", { method: "DELETE" })
    .then(() => loadDesk())
    .catch((err) => console.error("Failed while forgetting the conversation:", err));
}

async function saveEmailDraft(outlook, body) {
  const letter = polishReply(body, outlook?.name);
  if (!letter) return;
  try {
    const response = await fetch("/desk/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: outlook.to || "",
        name: outlook.name || "",
        subject: outlook.subject || "",
        body: letter,
        original: outlook.original || "",
      }),
    });
    if (!response.ok) throw new Error("Could not save the draft.");
    await loadDesk();
  } catch (err) {
    console.error("Failed while saving the email draft:", err);
  }
}

async function deskAction(url) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "That did not work.");
    return data;
  } catch (err) {
    console.error("Failed while updating the work list:", err);
    setStatus(err.message || "That did not work.");
    return null;
  }
}

function addCardButton(parent, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn small";
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.append(button);
}

/** Show or hide the work cards. The choice is kept on this Mac. */
function applyDeskFold() {
  deskEl.classList.toggle("is-collapsed", !deskOpen);
  if (!deskToggle) return;
  deskToggle.textContent = deskOpen ? "Collapse" : "Expand";
  deskToggle.setAttribute("aria-expanded", deskOpen ? "true" : "false");
}

if (deskToggle) {
  deskToggle.addEventListener("click", () => {
    deskOpen = !deskOpen;
    localStorage.setItem("deskOpen", deskOpen ? "open" : "closed");
    applyDeskFold();
  });
}

/**
 * A short note under a card: what the email or message is about.
 * about is "reply" when answering someone, or "draft" for a new email.
 */
function appendAbout(parent, about, summary) {
  if (about !== "reply" && about !== "draft") return;
  const line = document.createElement("p");
  line.className = "work-about";
  const label = document.createElement("span");
  label.textContent = about === "draft" ? "This draft" : "Replying to";
  line.append(label, document.createTextNode(summary || "Reading that message…"));
  parent.append(line);
}

function renderDesk() {
  const jobs = deskView.jobs || [];
  const suggestions = deskView.suggestions || [];
  const memory = deskView.memory || {};
  const showMemory = Boolean(memory.summary || memory.lastQuestion);
  deskCards.replaceChildren();
  if (!jobs.length && !suggestions.length && !showMemory && !flashes.length) {
    deskEl.hidden = true;
    return;
  }
  deskEl.hidden = false;
  if (deskCount) deskCount.textContent = String(jobs.length + suggestions.length + flashes.length + (showMemory ? 1 : 0));
  applyDeskFold();

  for (const card of flashes) {
    const article = document.createElement("article");
    article.className = "work-card";
    const kicker = document.createElement("p");
    kicker.className = "work-kicker";
    kicker.textContent = card.title || "Just now";
    const list = document.createElement("ul");
    for (const line of card.lines || []) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    article.append(kicker, list);
    deskCards.append(article);
  }

  for (const job of jobs) {
    const article = document.createElement("article");
    article.className = "work-card";
    const kicker = document.createElement("p");
    kicker.className = "work-kicker";
    kicker.textContent = job.kind === "draft"
      ? "Draft · waiting for you"
      : job.kind === "watch"
        ? (job.status === "alerted" ? "Watch · changed" : "Watch")
        : "Reminder";
    const title = document.createElement("h3");
    title.textContent = job.title;
    article.append(kicker, title);
    appendAbout(article, job.about, job.summary);
    const detail = document.createElement("p");
    detail.textContent = job.detail || job.receipt || "";
    article.append(detail);
    const actions = document.createElement("div");
    actions.className = "work-actions";
    if (job.kind === "draft") {
      addCardButton(actions, "Open in Outlook", async (event) => {
        event.currentTarget.disabled = true;
        setStatus("Opening Outlook…");
        const data = await deskAction(`/desk/jobs/${job.id}/open`);
        if (data?.text) setStatus(data.text);
        await loadDesk();
      });
      addCardButton(actions, "Drop", async () => {
        await deskAction(`/desk/jobs/${job.id}/skip`);
        setStatus("Dropped. Nothing was opened.");
        await loadDesk();
      });
    } else {
      if (job.status === "alerted") addCardButton(actions, "Got it", () => askTyped("got it"));
      addCardButton(actions, "Drop", async () => {
        await deskAction(`/desk/jobs/${job.id}/skip`);
        flashes = flashes.filter((card) => card.title !== job.title && !(card.lines || []).includes(job.title));
        setStatus(job.kind === "watch" ? "Stopped watching." : "Dropped that reminder.");
        await loadDesk();
      });
    }
    article.append(actions);
    deskCards.append(article);
  }

  for (const item of suggestions) {
    const article = document.createElement("article");
    article.className = "work-card";
    const kicker = document.createElement("p");
    kicker.className = "work-kicker";
    kicker.textContent = `Idea · ${item.at ? numericStamp(item.at) : item.source || "recent email"}`;
    const title = document.createElement("h3");
    title.textContent = item.title;
    article.append(kicker, title);
    appendAbout(article, item.about || "reply", item.summary);
    const actions = document.createElement("div");
    actions.className = "work-actions";
    addCardButton(actions, "Do this", async (event) => {
      event.currentTarget.disabled = true;
      const data = await deskAction(`/desk/suggestions/${item.id}/do`);
      await loadDesk();
      if (data?.question) askTyped(data.question);
    });
    addCardButton(actions, "Skip", async () => {
      await deskAction(`/desk/suggestions/${item.id}/skip`);
      await loadDesk();
    });
    article.append(actions);
    deskCards.append(article);
  }

  if (showMemory) {
    const article = document.createElement("article");
    article.className = "work-card";
    const kicker = document.createElement("p");
    kicker.className = "work-kicker";
    kicker.textContent = "Last conversation";
    const title = document.createElement("h3");
    title.textContent = memory.lastQuestion || "Saved for the next time you start talking";
    article.append(kicker, title);
    if (memory.summary) {
      const detail = document.createElement("p");
      detail.textContent = memory.summary.slice(0, 280);
      article.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "work-actions";
    addCardButton(actions, "Forget this", () => {
      chatTurns = [];
      chatMemory = "";
      savedMeeting = "";
      forgetSavedChat();
    });
    article.append(actions);
    deskCards.append(article);
  }
}

async function loadDesk() {
  try {
    const response = await fetch("/desk");
    if (!response.ok) throw new Error("Could not load saved work.");
    deskView = await response.json();
    if (!chatRestored) {
      chatRestored = true;
      const memory = deskView.memory || {};
      if (!chatTurns.length) {
        chatMemory = memory.summary || "";
        chatTurns = Array.isArray(memory.turns) ? memory.turns : [];
      }
    }
    renderDesk();
  } catch (err) {
    console.error("Failed while loading saved work:", err);
  }
}

const deskReady = loadDesk();

/** "2026-10-15 18:58": a card's date in numbers. The voice still says it in words. */
function numericStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The skill that stays on for later questions, until turned off. */
function setActiveSkill(id) {
  activeSkillId = id || "";
  renderSkills();
}

/** Show which skill is on, with a button to turn it off. Type / to choose one. */
function renderSkills() {
  if (!skillList) return;
  skillList.replaceChildren();
  const skill = skillCatalog.find((item) => item.id === activeSkillId);
  if (!skill) {
    skillList.textContent = skillCatalog.length
      ? `${skillCatalog.length} skills. Type / in the question box.`
      : "No skills yet. Add one to ~/.claude/skills.";
    return;
  }
  const label = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = `/${skill.id}`;
  label.append("On: ", name);
  const off = document.createElement("button");
  off.type = "button";
  off.className = "ghost-btn small";
  off.textContent = "Turn off";
  off.addEventListener("click", () => {
    setActiveSkill("");
    setStatus("Skill off.");
  });
  skillList.append(label, off);
}

/** Skills whose /name or name starts with (or contains) what was typed after the slash. */
function slashMatches(typed) {
  const q = typed.toLowerCase();
  const brain = !q || "brain".startsWith(q)
    ? [{ id: "brain", name: "Brain functions", description: "Table of every phrase you can tell the brain" }]
    : [];
  const starts = skillCatalog.filter((s) => s.id.startsWith(q) || s.name.toLowerCase().startsWith(q));
  const contains = skillCatalog.filter((s) => !starts.includes(s) && (s.id.includes(q) || s.name.toLowerCase().includes(q)));
  return [...brain, ...starts, ...contains].slice(0, 8);
}

let slashPick = 0;

function closeSlashMenu() {
  slashMenu.hidden = true;
  slashMenu.replaceChildren();
}

function chooseSlash(skill) {
  closeSlashMenu();
  if (skill.id === "brain") {
    typeInput.value = "/brain";
    typeForm.requestSubmit();
    return;
  }
  typeInput.value = `/${skill.id} `;
  typeInput.focus();
}

/** While the question box holds "/name" (no space yet), list the matching skills. */
function renderSlashMenu() {
  const match = typeInput.value.match(/^\/(\S*)$/);
  if (!match) return closeSlashMenu();
  const found = slashMatches(match[1]);
  if (!found.length) return closeSlashMenu();
  slashPick = Math.min(slashPick, found.length - 1);
  slashMenu.replaceChildren(...found.map((skill, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `slash-item${index === slashPick ? " is-on" : ""}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === slashPick ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = `/${skill.id}`;
    const about = document.createElement("span");
    about.textContent = skill.description || skill.name;
    item.append(title, about);
    // mousedown, so the box does not lose focus before the click lands.
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseSlash(skill);
    });
    return item;
  }));
  slashMenu.hidden = false;
}

typeInput.addEventListener("input", () => {
  slashPick = 0;
  renderSlashMenu();
});
typeInput.addEventListener("keydown", (event) => {
  if (slashMenu.hidden) return;
  const count = slashMenu.children.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    slashPick = (slashPick + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    renderSlashMenu();
  } else if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    const typed = typeInput.value.slice(1);
    chooseSlash(slashMatches(typed)[slashPick]);
  } else if (event.key === "Escape") {
    closeSlashMenu();
  }
});
typeInput.addEventListener("blur", () => setTimeout(closeSlashMenu, 150));

/** Read the skill files the server keeps, and show their names. */
async function loadSkills() {
  try {
    const response = await fetch("/skills");
    if (!response.ok) throw new Error("Could not load skills.");
    const data = await response.json();
    skillCatalog = Array.isArray(data.skills) ? data.skills : [];
    if (activeSkillId && !skillCatalog.some((skill) => skill.id === activeSkillId)) {
      activeSkillId = "";
    }
    renderSkills();
  } catch (err) {
    console.error("Failed while loading skills:", err);
  }
}

loadSkills();

async function loadSettings() {
  try {
    const [modelsResponse, foldersResponse, healthResponse] = await Promise.all([
      fetch("/models"),
      fetch("/folders"),
      fetch("/health"),
    ]);
    catalog = await modelsResponse.json();
    const health = await healthResponse.json();
    if (health.defaultModel) defaultModelId = health.defaultModel;
    fillModels();
    fillFolders(await foldersResponse.json());
  } catch (err) {
    console.error("Failed while loading settings:", err);
    ratesEl.textContent = "Could not load models and folders.";
  }
}

async function chooseFolders(paths) {
  try {
    const response = await fetch("/folders/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not change the folders.");
    fillFolders(data);
    setStatus(`Using ${data.notes.toLocaleString()} notes. The rulebook is ~/.brain/code.md.`);
  } catch (err) {
    console.error("Failed while choosing folders:", err);
    setStatus(err.message || "Could not change the folders.");
  }
}

async function removeFolder(folderPath) {
  const ok = window.confirm("Remove this folder from the list? The files stay on your Mac.");
  if (!ok) return;
  try {
    const response = await fetch("/folders/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not remove that folder.");
    fillFolders(data);
    setStatus(`Removed from the list. ${data.notes.toLocaleString()} notes still in use.`);
  } catch (err) {
    console.error("Failed while removing a folder:", err);
    setStatus(err.message || "Could not remove that folder.");
  }
}

/** Add one folder by its full path, then refresh the list. */
async function addFolder(folder) {
  if (!folder) return;
  addFolderBtn.disabled = true;
  if (browseFolderBtn) browseFolderBtn.disabled = true;
  try {
    const response = await fetch("/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not add that folder.");
    folderPath.value = "";
    fillFolders(data);
    setStatus(`Added folder. ${data.notes.toLocaleString()} notes ready.`);
  } catch (err) {
    console.error("Failed while adding a folder:", err);
    setStatus(err.message || "Could not add that folder.");
  } finally {
    addFolderBtn.disabled = false;
    if (browseFolderBtn) browseFolderBtn.disabled = false;
  }
}

addFolderBtn.addEventListener("click", () => {
  addFolder(folderPath.value.trim());
});

// Opens the same folder window other Mac apps use, then adds the folder you pick.
if (browseFolderBtn) browseFolderBtn.addEventListener("click", async () => {
  browseFolderBtn.disabled = true;
  addFolderBtn.disabled = true;
  setStatus("Choose a folder…");
  try {
    const response = await fetch("/folders/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not open the folder window.");
    if (!data.path) {
      setStatus("No folder was chosen.");
      return;
    }
    await addFolder(data.path);
  } catch (err) {
    console.error("Failed while browsing for a folder:", err);
    setStatus(err.message || "Could not open the folder window.");
  } finally {
    browseFolderBtn.disabled = false;
    addFolderBtn.disabled = false;
  }
});

modelSelect.addEventListener("change", () => {
  const previousId = chosenModelId;
  chosenModelId = modelSelect.value;
  fillReasoning();
  showRates();
  releasePreviousLocalModel(previousId);
});
reasoningSelect.addEventListener("change", showRates);

loadSettings();
renderChat();
