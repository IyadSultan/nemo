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

/** "Open the stickies" or "close the stickies", done here without asking a model. */
function runStickiesAsk(question) {
  const ask = window.brainStickies?.command(question);
  if (!ask) return false;
  if (ask === "open") window.brainStickies.openPanel();
  else window.brainStickies.close();
  addBubble("assistant", ask === "open" ? "The sticky notes are open." : "Closed the sticky notes.");
  setStatus(listenStatus());
  return true;
}

// Spoken surah names, folded the same way as surahNamePattern() in quran.js.
const QURAN_SURAH_KEYS = "almuddaththir|almutaffifin|adhdhariyat|almumtahana|almunafiqun|almuzzammil|muddaththir|almujadila|attaghabun|almursalat|mutaffifin|alinshiqaq|alghashiya|attakathur|almuminun|ashshuara|alankabut|azzukhruf|aljathiya|alhujurat|mumtahana|munafiqun|muzzammil|alinfitar|albayyina|azzalzala|alkawthar|alkafirun|alfatiha|albaqara|aliimran|alanbiya|alfurqan|assaffat|fussilat|ashshura|addukhan|muhammad|dhariyat|arrahman|mujadila|taghabun|attahrim|almaarij|alqiyama|mursalat|annaziat|attakwir|inshiqaq|ghashiya|ashshams|inshirah|aladiyat|takathur|alhumaza|elephant|alikhlas|opening|fatihat|baqarah|alimran|almaida|alanfal|attawba|ibrahim|muminun|alqasas|ankabut|assajda|alahzab|azzumar|zukhruf|jathiya|alahqaf|hujurat|alqamar|alwaqia|alhadid|alhashr|aljumua|attalaq|alqalam|alhaqqa|alinsan|infitar|alburuj|attariq|albalad|addhuha|ashshar|inshira|bayyina|zalzala|alqaria|quraysh|kawthar|kauthar|kafirun|almasad|alfalaq|mankind|fatiha|baqara|bakara|annisa|alanam|alaraf|tawbah|alhijr|annahl|alisra|alkahf|maryam|anbiya|alhajj|furqan|shuara|annaml|luqman|yassin|saffat|ghafir|dukhan|annajm|rahman|rehman|assaff|tahrim|almulk|maarij|aljinn|qiyama|annaba|naziat|takwir|alfajr|allail|alalaq|alqadr|adiyat|humaza|qurais|qurays|almaun|annasr|ikhlas|imran|maida|anfal|tawba|tauba|yunus|yusuf|arrad|annur|qasas|arrum|sajda|ahzab|fatir|yasin|zumar|shura|ahqaf|alfat|attur|qamar|waqia|hadid|hashr|jumua|talaq|qalam|haqqa|insan|abasa|buruj|tariq|alala|balad|shams|dhuha|attin|qaria|alasr|alfil|masad|lahab|falaq|annas|nisa|anam|araf|hijr|nahl|isra|kahf|cave|mary|taha|hajj|naml|saba|fath|najm|saff|mulk|noah|jinn|naba|fajr|lail|shar|alaq|qadr|maun|nasr|cow|hud|rad|nur|rum|sad|qaf|tur|nuh|ala|tin|asr|fil|nas";

/** "Al-Baqarah" and "Baqara" become the same letters. */
function foldSurahWord(text) {
  const key = String(text || "")
    .toLowerCase()
    .replace(/aa/g, "a")
    .replace(/ee/g, "i")
    .replace(/ii/g, "i")
    .replace(/oo/g, "u")
    .replace(/uu/g, "u")
    .replace(/[^a-z0-9]/g, "");
  return key.endsWith("h") && key.length > 4 ? key.slice(0, -1) : key;
}

/** True when the sentence names a surah, even without the word "surah". */
function mentionsSurahName(q) {
  const keys = new Set(QURAN_SURAH_KEYS.split("|"));
  const words = q.split(/\s+/).map(foldSurahWord);
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].length >= 3 && keys.has(words[i])) return true;
    if (words[i + 1] && keys.has(words[i] + words[i + 1])) return true;
    const stripped = words[i].replace(/^(?:al|an|ar|as|at|ad|ash)/, "");
    if (stripped.length >= 3 && keys.has(stripped)) return true;
  }
  return false;
}

/**
 * Same test as wantsQuran in quran.js.
 * A live voice model would answer this itself. The installed Quran text must answer instead.
 */
function wantsQuranAsk(question) {
  const raw = String(question || "");
  const q = raw.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}\s:]/gu, " ").replace(/\s+/g, " ").trim();
  if (!q) return false;
  if (/^(?:what|why|how|when|where|who|which)\b/.test(q)) return false;
  if (/\b(?:mean|meaning|means|explain|tafsir|interpret)\b/.test(q)) return false;
  if (/\b(?:notes?|emails?|memos?|files?|documents?|pdf|paper|wiki)\b/.test(q)) return false;
  if (/\b(?:bible|poem|poetry|song|songs|shakespeare|lyrics|torah|gospel)\b/.test(q)) return false;
  const asks = /\b(?:recite|quote|chant|play|listen|read|give|share)\b/.test(q) || /اقرأ|اتل/.test(raw);
  if (!asks) return false;
  if (/\b(?:verses?|ayahs?|ayat|aya|quran|koran|surahs?|surat|sura|chapters?|kursi)\b/.test(q)) return true;
  if (/قرآن|قران|سورة|سوره|آيات|آية|ايات/.test(raw)) return true;
  if (/\b(?:recite|quote|chant|play|read)\s+(?:\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\b/.test(q) && mentionsSurahName(q)) return true;
  if (/\b(?:recite|quote|chant|play|read)\s+(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/.test(q)) return true;
  return mentionsSurahName(q);
}

/** "Open the calendar" or "close the calendar", done here without asking a model. */
function runCalendarAsk(question) {
  const ask = window.brainCalendar?.command(question);
  if (!ask) return false;
  if (ask === "open") window.brainCalendar.openPanel();
  else if (ask === "add") window.brainCalendar.addAppointment();
  else window.brainCalendar.close();
  const said = ask === "open" ? "The calendar is open." : ask === "add" ? "Type the appointment, then press Add in Outlook." : "Closed the calendar.";
  addBubble("assistant", said);
  setStatus(listenStatus());
  return true;
}

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

/**
 * "Can you dance?" or "Tiny, wave" makes Tiny do that move for a few seconds.
 * Only short requests count, so "add the dance class to my calendar" is left alone.
 * Returns the pose, or "".
 */
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
  if (/mistral_api_key/i.test(msg)) return "The Mistral key is missing from the .env file.";
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
  if (typeof paintUsagePill === "function") paintUsagePill();
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
  if (typeof paintUsagePill === "function") paintUsagePill();
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
    ? " The written answer is free on this Mac. Listening is free too. A voice on this Mac speaks it, so nothing goes to OpenAI."
    : model.audioInputPerMillion
    ? ` Audio is ${formatRate(model.audioInputPerMillion)} in and ${formatRate(model.audioOutputPerMillion)} out per million tokens.`
    : " Listening stays on this Mac, so that part is free. Voice control only speaks the answer.";
  const voiceNote = model.local
    ? " The Voice menu lists the voices on this Mac."
    : model.gemini
    ? " The Voice menu lists Gemini's voices."
    : " The Voice menu chooses the OpenAI voice that reads the answer.";
  ratesEl.textContent = `${model.label}: text ${formatRate(model.inputPerMillion)} in and ${formatRate(model.outputPerMillion)} out per million tokens.${audio}${voiceNote} ${model.blurb} Change the model, thinking, or voice before you press Start talking. That choice stays for the whole chat.`;
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

/**
 * Grey the settings the picked model does not use, so it is clear who hears, thinks, and speaks.
 * A model that hears for itself (Voice, Gemini Live) needs no Listening or Wake.
 * Gemini Live also thinks and speaks on its own.
 */
function markUnusedSettings() {
  const model = selectedModel();
  const unused = [
    [reasoningSelect, model?.gemini],
    [earsSelect, model?.hears],
    [mouthSelect, model?.gemini],
    [wakeSelect, model?.hears],
  ];
  for (const [select, off] of unused) {
    const field = select.closest(".field");
    field.classList.toggle("is-unused", Boolean(off));
    if (off) field.title = `${model.label} hears you itself${model.gemini ? ", thinks, and speaks in its own voice" : ""}. This setting is not used. Pick another model to use it.`;
    else field.removeAttribute("title");
  }
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
  fillVoices();
  showRates();
  markUnusedSettings();
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
      // The app window (WebKit via wry) has no confirm() dialog, so the button asks twice.
      if (remove.dataset.armed !== "1") {
        remove.dataset.armed = "1";
        remove.textContent = "Click again to remove";
        setTimeout(() => {
          remove.dataset.armed = "";
          remove.textContent = "Remove";
        }, 4000);
        return;
      }
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

/** The question after a plan is saved, with Add to calendar and Not now. */
function showPlanCalendarAsk(ask) {
  flashes = flashes.filter((card) => !card.calendarAsk);
  showFlash({
    title: ask.title || "Plan",
    lines: [ask.text || "Should I add this to your calendar?"],
    calendarAsk: true,
    planId: ask.id,
  });
}

function clearPlanCalendarAsk() {
  if (!flashes.some((card) => card.calendarAsk)) return;
  flashes = flashes.filter((card) => !card.calendarAsk);
  renderDesk();
}

function persistChat() {
  fetch("/desk/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memory: chatMemory, turns: chatTurns, files: chatFiles }),
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
    if (card.calendarAsk && card.planId) {
      const actions = document.createElement("div");
      actions.className = "work-actions";
      addCardButton(actions, "Add to calendar", async (event) => {
        event.currentTarget.disabled = true;
        setStatus("Opening Outlook…");
        try {
          const response = await fetch(`/plans/${encodeURIComponent(card.planId)}/calendar`, { method: "POST" });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Outlook did not open.");
          setStatus(data.text || "Opened in Outlook. Press Add there.");
        } catch (err) {
          console.error("Failed while opening a plan in Outlook:", err);
          setStatus(err.message || "Outlook did not open.");
          event.currentTarget.disabled = false;
        }
      });
      addCardButton(actions, "Not now", async () => {
        try {
          await fetch("/plans/calendar/skip", { method: "POST" });
        } catch (err) {
          console.error("Failed while skipping the calendar question:", err);
        }
        clearPlanCalendarAsk();
        window.brainPlans?.clearCalendarAsk();
        setStatus("It stays in your plans.");
      });
      article.append(actions);
    }
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
        : job.kind === "schedule"
          ? (job.status === "paused" ? "Scheduled · paused" : "Scheduled")
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
    } else if (job.kind === "schedule") {
      if (job.status === "paused") {
        addCardButton(actions, "Resume", async () => {
          const data = await deskAction(`/desk/jobs/${job.id}/resume`);
          if (data?.text) setStatus(data.text);
          await loadDesk();
        });
      } else {
        addCardButton(actions, "Pause", async () => {
          const data = await deskAction(`/desk/jobs/${job.id}/pause`);
          if (data?.text) setStatus(data.text);
          await loadDesk();
        });
      }
      addCardButton(actions, "Drop", async () => {
        await deskAction(`/desk/jobs/${job.id}/skip`);
        setStatus("Dropped that scheduled job.");
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
      chatFiles = [];
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
        chatFiles = Array.isArray(memory.files) ? memory.files : [];
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

// The little microphone next to the prompt. One press listens, the next press stops.
const dictateBtn = document.getElementById("dictateBtn");
let dictateStop = null;
let dictating = false;

/**
 * Record until the person pauses, or until stop() is called.
 * With hold, a pause does not end it: it records until Space is let go.
 * The clip stays on this Mac and is written down by the local voice model.
 */
function recordPromptClip(stream, hold) {
  return new Promise((resolve) => {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    let settled = false;
    let stopNow = false;
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
      if (settled) return;
      settled = true;
      resolve(new Blob(chunks, { type: mime }));
    };

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let heard = false;
    let quietSince = 0;
    const started = performance.now();
    // Declared before rec.start(), so finish() can run if the recorder will not start.
    let timer = null;
    try {
      rec.start();
    } catch (err) {
      console.error("Failed while starting the prompt recorder:", err);
      finish();
      return;
    }

    timer = setInterval(() => {
      if (stopNow || hold?.released) {
        finish();
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const sample = (value - 128) / 128;
        sum += sample * sample;
      }
      const loudness = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (loudness > 0.025) {
        heard = true;
        quietSince = 0;
      } else if (!hold && heard && now - started > 400) {
        if (!quietSince) quietSince = now;
        // A short pause means the prompt is finished.
        if (now - quietSince > 900) finish();
      }
      if (now - started > (hold ? 120000 : 20000)) finish();
    }, 80);

    dictateStop = () => {
      stopNow = true;
    };

    function finish() {
      clearInterval(timer);
      dictateStop = null;
      try { source.disconnect(); } catch { /* already disconnected */ }
      ctx.close().catch(() => {});
      if (rec.state !== "inactive") rec.stop();
      else if (!settled) {
        settled = true;
        resolve(new Blob());
      }
    }
  });
}

/** Stop the live call from hearing this sentence, then put the microphone back. */
async function parkCallMic(park) {
  if (!pc) return;
  const sender = pc.getSenders().find((item) => !item.track || item.track.kind === "audio");
  if (!sender) return;
  try {
    if (park) {
      if (sender.track) sender._parked = sender.track;
      await sender.replaceTrack(null);
    } else if (sender._parked) {
      await sender.replaceTrack(sender._parked);
      sender._parked = null;
    }
  } catch (err) {
    console.error("Failed while holding the call microphone:", err);
  }
}

function paintDictate(on) {
  dictateBtn.classList.toggle("is-on", on);
  dictateBtn.setAttribute("aria-pressed", on ? "true" : "false");
  dictateBtn.disabled = false;
}

dictateBtn?.addEventListener("click", () => {
  if (dictating) {
    dictateStop?.();
    return;
  }
  dictatePrompt(null);
});

/**
 * Hear one prompt. The microphone button asks it at once.
 * Holding Space (hold is set) writes it into the chat box instead, so it can be edited first.
 */
async function dictatePrompt(hold) {
  dictating = true;
  paintDictate(true);
  setStatus(hold ? "Listening… let go of Space when you're done." : "Listening… say the prompt. Press the microphone again to stop.");
  const hadMic = micStream?.getAudioTracks().some((track) => track.readyState === "live");
  dictateHold = true;
  let stream = null;
  let heard = "";
  try {
    await parkCallMic(true);
    const waitUntil = performance.now() + 2500;
    while ((recordingClip || micBusy) && performance.now() < waitUntil) await sleep(40);
    stream = await ensureMic();
    const clip = await recordPromptClip(stream, hold);
    paintDictate(false);
    dictateBtn.disabled = true;
    setStatus("Writing down what you said…");
    if (!clip || clip.size < 2000) {
      setStatus("I didn't catch that. Press the microphone and try again.");
      return;
    }
    const text = await transcribeClip(clip);
    if (!text || looksLikeSilence(text)) {
      setStatus("I didn't catch that. Press the microphone and try again.");
      return;
    }
    heard = text;
  } catch (err) {
    console.error("Failed while dictating the prompt:", err);
    setStatus(err?.message || "The microphone did not open. Check Sound in System Settings, then try again.");
  } finally {
    dictateHold = false;
    dictating = false;
    dictateStop = null;
    paintDictate(false);
    await parkCallMic(false);
    if (!hadMic && !connected && !meetingOn && !quietCapture && stream) {
      stream.getTracks().forEach((track) => track.stop());
      if (micStream === stream) micStream = null;
    }
  }
  if (heard && hold) {
    const at = typeInput.selectionStart ?? typeInput.value.length;
    const gap = /\S$/.test(typeInput.value.slice(0, at)) ? " " : "";
    typeInput.setRangeText(gap + heard, at, typeInput.selectionEnd ?? at, "end");
    typeInput.focus();
    setStatus("Edit it if you like, then press Enter.");
    return;
  }
  // Asked after the mic is given back, so Hey and "stop" are heard while this answer is written.
  if (heard) {
    typeInput.value = heard;
    askTyped(heard).catch((err) => console.error("Failed while asking the dictated prompt:", err));
  }
}

// Hold Space to dictate into the chat box, like Claude Code. A tap still types a space.
// Only in the chat box or with nothing focused, so buttons, editors and the terminal keep Space.
const SPACE_HOLD_MS = 400;
let spaceTimer = null;
let spaceHold = null;
document.addEventListener("keydown", (event) => {
  // defaultPrevented: the slide show already took Space as "next slide".
  if (event.code !== "Space" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const el = event.target;
  if (el !== typeInput && el !== document.body) return;
  if (event.repeat) {
    // A held key would fill the box with spaces.
    event.preventDefault();
    return;
  }
  if (dictating || spaceHold) return;
  clearTimeout(spaceTimer);
  spaceTimer = setTimeout(() => {
    spaceTimer = null;
    if (dictating) return;
    // Take back the space the first press typed.
    const at = typeInput.selectionStart;
    if (el === typeInput && at && typeInput.value[at - 1] === " ") {
      typeInput.setRangeText("", at - 1, at, "end");
    }
    spaceHold = { released: false };
    dictatePrompt(spaceHold).finally(() => { spaceHold = null; });
  }, SPACE_HOLD_MS);
});
document.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  clearTimeout(spaceTimer);
  spaceTimer = null;
  if (spaceHold) spaceHold.released = true;
});
// Switching apps while Space is down never sends the keyup.
window.addEventListener("blur", () => {
  clearTimeout(spaceTimer);
  spaceTimer = null;
  if (spaceHold) spaceHold.released = true;
});

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
  fillVoices();
  showRates();
  markUnusedSettings();
  releasePreviousLocalModel(previousId);
});
reasoningSelect.addEventListener("change", showRates);

// Fill the screen, or come back. The button and a click on the top bar both do this.
// Buttons in the bar (PDF, Word, Terminal, and so on) keep their own jobs.
(function setupExpand() {
  const bar = document.querySelector(".topbar");
  const btn = document.getElementById("expandBtn");
  if (!bar || !btn) return;
  let full = false;

  function paint(on) {
    full = on;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Leave full screen" : "Fill the screen");
    btn.title = on ? "Leave full screen" : "Fill the screen";
  }

  function setFull(on) {
    try {
      paint(on);
      // The Mac window app understands these two messages. A normal browser uses its own full screen.
      if (window.ipc?.postMessage) {
        window.ipc.postMessage(on ? "fullscreen-on" : "fullscreen-off");
        return;
      }
      if (on) {
        const ask = document.documentElement.requestFullscreen?.();
        if (ask && ask.catch) ask.catch((err) => {
          console.error("Failed while filling the screen:", err);
          paint(false);
        });
        else if (!ask) paint(false);
      } else if (document.fullscreenElement) {
        document.exitFullscreen?.().catch((err) => console.error("Failed while leaving full screen:", err));
      }
    } catch (err) {
      console.error("Failed in the expand button:", err);
      paint(false);
    }
  }

  btn.addEventListener("click", () => setFull(!full));
  bar.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea, label, .clock-pill")) return;
    setFull(!full);
  });
  // Esc, or the browser leaving full screen on its own, puts the button back.
  document.addEventListener("fullscreenchange", () => paint(Boolean(document.fullscreenElement)));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !full || event.defaultPrevented) return;
    if (window.brainDeck?.open) return;
    setFull(false);
  });
})();

loadSettings();
renderChat();
