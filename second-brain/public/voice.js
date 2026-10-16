/**
 * Voice window for the second brain.
 *
 * Voice-control models (Voice mini, Voice) hear the microphone themselves.
 * Bonsai and the GPT-6 models cannot hear. For those, this Mac writes
 * down your words with the local voice model, the chosen model writes
 * the answer, and Voice mini (voice control) is the only voice that
 * speaks it. The microphone is not sent to OpenAI.
 *
 * The page code is split across voice.js and voice-*.js. They are classic
 * scripts that share one global scope, so voice.html must load them in order.
 */

const talkBtn = document.getElementById("talkBtn");
const talkLabel = document.getElementById("talkLabel");
const statusText = document.getElementById("statusText");
const capsule = document.getElementById("capsule");
const voiceSelect = document.getElementById("voiceSelect");
const muteBtn = document.getElementById("muteBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const restartBtn = document.getElementById("restartBtn");
const clearBtn = document.getElementById("clearBtn");
const saveClearBtn = document.getElementById("saveClearBtn");
const typeForm = document.getElementById("typeForm");
const typeInput = document.getElementById("typeInput");
const transcriptEl = document.getElementById("transcript");
const deskEl = document.getElementById("desk");
const deskCards = document.getElementById("deskCards");
const deskToggle = document.getElementById("deskToggle");
const deskCount = document.getElementById("deskCount");
// "closed" keeps the work list folded after a reload. Anything else leaves it open.
let deskOpen = localStorage.getItem("deskOpen") !== "closed";
const remoteAudio = document.getElementById("remoteAudio");
const folderList = document.getElementById("folderList");
const skillList = document.getElementById("skillList");
const slashMenu = document.getElementById("slashMenu");
const folderPath = document.getElementById("folderPath");
const addFolderBtn = document.getElementById("addFolderBtn");
const browseFolderBtn = document.getElementById("browseFolderBtn");
const modelSelect = document.getElementById("modelSelect");
const reasoningSelect = document.getElementById("reasoningSelect");
const ratesEl = document.getElementById("rates");
const inTokensEl = document.getElementById("inTokens");
const outTokensEl = document.getElementById("outTokens");
const thinkTokensEl = document.getElementById("thinkTokens");
const chatPriceEl = document.getElementById("chatPrice");
const lastWaitEl = document.getElementById("lastWait");
const avgWaitEl = document.getElementById("avgWait");
const breakdownEl = document.getElementById("breakdown");
const earsSelect = document.getElementById("earsSelect");
const wakeSelect = document.getElementById("wakeSelect");
const micSelect = document.getElementById("micSelect");
const meetingBtn = document.getElementById("meetingBtn");
const lectureBtn = document.getElementById("lectureBtn");
const recapBtn = document.getElementById("recapBtn");
const photoBtn = document.getElementById("photoBtn");
const documentBtn = document.getElementById("documentBtn");
const documentFile = document.getElementById("documentFile");
const photoSheet = document.getElementById("photoSheet");
const photoVideo = document.getElementById("photoVideo");
const cameraSelect = document.getElementById("cameraSelect");
const shutterBtn = document.getElementById("shutterBtn");
const photoCancelBtn = document.getElementById("photoCancelBtn");
const photoError = document.getElementById("photoError");
const photoHint = document.getElementById("photoHint");

let pc = null;
let dc = null;
let micStream = null;
let assistantPartialEl = null;
let userPartialEl = null;
let connected = false;
let muted = false;
let paused = false;
let lastQuestion = "";
let pendingReplay = "";
let askAbort = null;
let activeSpeech = null;
let cancelAnswer = false;
let currentAnswerBubble = null;
let listenEpoch = 0;
let activeReader = null;
// Meeting or lecture: write down every sentence and do not answer until it is turned off.
let meetingOn = false;
// "meeting" or "lecture" while that button is on, and until its summary is finished.
let captureKind = "";
// True while the presenter and title form is on screen, so speech is not answered.
let lectureFormOpen = false;
// Resolves that form if the call ends before the listener submits it.
let settleLectureForm = null;
// "lecture" after a talk is kept, so later questions treat those words as a talk.
let savedNotesKind = "";
let meetingLines = [];
// JPEG photos taken while Meeting or Lecture is on. Saved with those notes.
let capturePhotos = [];
// Copied when Meeting or Lecture turns off, so a new recording does not erase them.
let photosToSave = [];
// The whole meeting or lecture as audio, saved next to the notes as a small .m4a.
let meetingRecording = null; // Promise<MediaRecorder | null> while capturing
let recordingToSave = null; // Promise<Blob | null> from the capture that just ended
// The newest photo from a normal talk, sent with the next question about it.
let latestShot = "";
let latestShotAt = 0;
let latestShotSent = false;
// True while the camera window is open, so a second press does not open two cameras.
let photoBusy = false;
let photoStream = null;
// Bumped when the camera window closes, so a late iPhone search does not reopen it.
let photoEpoch = 0;
// True after the user picks a camera themselves, so a late iPhone does not override that pick.
let photoPickedByUser = false;
let meetingPartial = "";
let meetingPartialBubble = null;
let closeMeetingAfterClip = false;
let linesToSummarize = null;
let meetingSummaryBusy = false;
let recapBusy = false;
// A recap stays put so it can be read. New lecture lines normally jump the
// transcript to the bottom, which hides the recap. That jump waits 30 seconds,
// and it keeps waiting while the user is scrolling.
const RECAP_HOLD_MS = 30000;
// After the last wheel, touch, or scrollbar move, the user is still "in control"
// for this long. Then the transcript may follow the lecture again.
const USER_SCROLL_MS = 800;
let recapPinned = false;
let recapHoldUntil = 0;
let userScrollingUntil = 0;
let recapHoldTimer = 0;
let userScrollTimer = 0;
// True while the pointer is down on the transcript (scrollbar drag or touch).
let pointerHoldingScroll = false;
// Our own scroll moves also fire "scroll". Ignore those so they are not
// mistaken for the user taking over.
let ignoreScrollUntil = 0;
let savedMeeting = "";
let meetingStartedAt = 0;
let meetingEndedAt = 0;
// The last finished meeting, for the Save minutes buttons.
let meetingToSave = null;
let meetingSaveRow = null;
// The skill the user turned on. Later questions keep using it until they stop it.
let activeSkillId = "";
let skillCatalog = [];
let skillLabel = "";
let recordingClip = false;
let localEars = false;
let queuedQuestion = "";
let micBusy = false;
// Command and Control together arms the next sentence, so it does not have to start with Hey.
let keyboardWake = false;
// Both keys are down. commandControlUsed means a letter was pressed while they were held.
let commandControlDown = false;
let commandControlUsed = false;
// The page and Hammerspoon can both notice the same press. Answer only once.
let lastKeyboardWake = 0;
// True while Start talking is still connecting, so a second press does not open two calls.
let wakeInFlight = false;
const handledCalls = new Set();
const countedResponses = new Set();
let catalog = null;
let defaultModelId = "claude-opus";
let chat = emptyChat();
// When the user stopped talking (performance.now), until the answer starts speaking.
let questionEndedAt = 0;
let answerWaits = [];

function emptyChat() {
  return {
    input: 0,
    output: 0,
    thinking: 0,
    textIn: 0,
    audioIn: 0,
    cachedTextIn: 0,
    cachedAudioIn: 0,
    textOut: 0,
    audioOut: 0,
    brainInput: 0,
    brainOutput: 0,
  };
}

let scriptedReply = false;
let brainBusy = false;
let speaker = null;

talkBtn.addEventListener("click", async () => {
  if (connected) {
    persistChat();
    await hangUp();
    await releaseAllLocalModels();
    return;
  }
  await startCall();
});

function syncCallButtons() {
  pauseBtn.disabled = !connected;
  // Stop also cancels an answer that was typed before the call started.
  stopBtn.disabled = !connected && !brainBusy;
  restartBtn.disabled = !lastQuestion;
  paintMeetingButton();
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  pauseBtn.classList.toggle("is-muted", paused);
}

function stopSpeaking() {
  clearThinkCue();
  activeSpeech?.stop();
  kokoroSpeech?.stop();
  speechSynthesis.cancel();
  silenceGeminiTurn();
  try { remoteAudio.pause(); } catch { /* nothing is playing */ }
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "response.cancel" }));
  }
}

function listenForNewQuestion() {
  // Drop the answer that is playing, keep the call, and wait for a new wake phrase.
  keyboardWake = false;
  listenEpoch += 1;
  cancelAnswer = true;
  paused = false;
  stopSpeaking();
  askAbort?.abort();
  compressAbort?.abort();
  compressGen += 1;
  try { activeReader?.cancel(); } catch { /* the answer already finished */ }
  if (micStream) {
    for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  }
  syncCallButtons();
  queuedQuestion = "";
  if (connected) {
    if (meetingOn) {
      setStatus(quietCaptureStatus());
      setCapsuleState(muted ? "muted" : captureRole());
    } else if (lectureFormOpen) {
      setStatus("Type the presenter's name and edit the title, then press Write summary.");
      setCapsuleState(muted ? "muted" : "listening");
    } else {
      setStatus(medicalListening() ? "Stopped. Keep talking. Only a real question goes to the brain." : "Say Hey, or press Command and Control together, then your new question.");
      setCapsuleState(muted ? "muted" : "listening");
    }
  } else {
    setStatus("Type a question, or press Start talking.");
    setCapsuleState("idle");
  }
}

pauseBtn.addEventListener("click", () => {
  if (!connected) return;
  listenForNewQuestion();
});

stopBtn.addEventListener("click", stopAnswer);

function stopAnswer() {
  if (!connected && !brainBusy) return;
  listenForNewQuestion();
}

// Cmd+Opt+S stops the answer. Option changes e.key (to "ß"), so match the physical key.
// Command and Control together starts listening, the same as saying Hey.
// A letter pressed while both are held is a different shortcut, so it does not listen.
function isCommandOrControl(code) {
  return code === "MetaLeft" || code === "MetaRight" || code === "ControlLeft" || code === "ControlRight";
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey && event.altKey && event.code === "KeyS" && !event.repeat) {
    event.preventDefault();
    stopAnswer();
    return;
  }
  const cleanChord = event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey;
  if (cleanChord && isCommandOrControl(event.code) && !event.repeat) {
    commandControlDown = true;
    commandControlUsed = false;
    return;
  }
  if (!commandControlDown) return;
  // Shift, Option, or a letter means this is not the listen shortcut.
  if (event.altKey || event.shiftKey || !isCommandOrControl(event.code)) commandControlUsed = true;
});

document.addEventListener("keyup", (event) => {
  if (!commandControlDown || !isCommandOrControl(event.code)) return;
  const el = event.target;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  const wake = !commandControlUsed && !typing;
  commandControlDown = false;
  commandControlUsed = false;
  if (wake) wakeFromKeyboard();
});

/**
 * Command and Control together, or the same keys from Hammerspoon.
 * The next thing you say is the question. You can still say Hey instead.
 */
function wakeFromKeyboard() {
  const now = performance.now();
  if (lastKeyboardWake && now - lastKeyboardWake < 800) return;
  lastKeyboardWake = now;
  if (meetingOn) {
    setStatus(`${captureName()} is on. I'm still only writing the words down.`);
    return;
  }
  if (lectureFormOpen) {
    setStatus("Type the presenter's name and edit the title, then press Write summary.");
    return;
  }
  if (!connected) {
    keyboardWake = true;
    if (wakeInFlight) return;
    wakeInFlight = true;
    startCall().finally(() => {
      wakeInFlight = false;
    });
    return;
  }
  // Stop whatever is playing, then take the next sentence without Hey.
  listenForNewQuestion();
  keyboardWake = true;
  setStatus(KEY_WAKE_STATUS);
  setCapsuleState(muted ? "muted" : "listening");
}

// The same shortcuts from any app: Hammerspoon posts here, the server passes them on.
const control = new EventSource("/control");
control.addEventListener("stop", stopAnswer);
control.addEventListener("listen", wakeFromKeyboard);
/** Read a notice aloud when the page is quiet (a briefing, a reminder, a page change). */
async function speakNotice(text) {
  if (!text || !["idle", "listening", undefined].includes(capsule.dataset.state)) return;
  const voice = kokoroVoice();
  activeSpeech = voice;
  setCapsuleState("speaking");
  voice.push(text);
  await voice.done.catch(() => {});
  if (activeSpeech === voice) activeSpeech = null;
  setCapsuleState(connected ? "listening" : "idle");
}

// The morning briefing (BRIEFING_AT in .env) is read aloud when this page is open and quiet.
control.addEventListener("briefing", (event) => {
  speakNotice(JSON.parse(event.data || "{}").text);
});
// A reminder or a watched page changed. The card list refreshes too.
control.addEventListener("job", (event) => {
  const data = JSON.parse(event.data || "{}");
  speakNotice(data.text);
  loadDesk();
});
control.addEventListener("desk", () => loadDesk());

// A typed question skips the wake phrase. Use it when the mic or dictation fails.
typeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  askTyped(typeInput.value);
});

/** "/brain" or "brain functions". Same test as wantsCommandTable in commands.js. */
function isCommandTableAsk(question) {
  const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s/]/gu, " ").replace(/\s+/g, " ").trim();
  if (q === "/brain" || q === "brain functions") return true;
  return /^(?:please |hey )?(?:show|list|give|tell)(?: me)? (?:the |about )?(?:brain functions|\/brain)$/.test(q);
}

/** The phrase table under the short spoken line. Rows come from the server. */
function mountCommandTable(bubble, rows) {
  if (!bubble || bubble.querySelector(".cmd-table")) return;
  bubble.classList.add("commands");
  const table = document.createElement("table");
  table.className = "cmd-table";
  const head = document.createElement("tr");
  for (const label of ["Say this", "What it does"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  const body = document.createElement("tbody");
  let group = "";
  for (const row of rows || []) {
    if (row.group && row.group !== group) {
      group = row.group;
      const banner = document.createElement("tr");
      banner.className = "cmd-group";
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.textContent = row.group;
      banner.append(cell);
      body.append(banner);
    }
    const line = document.createElement("tr");
    const say = document.createElement("td");
    say.className = "cmd-say";
    say.textContent = row.say || "";
    const does = document.createElement("td");
    does.textContent = row.does || "";
    line.append(say, does);
    body.append(line);
  }
  table.append(head, body);
  bubble.append(table);
  followTranscript();
}

async function askTyped(raw) {
  let question = String(raw || "").trim();
  if (!question) {
    typeInput.focus();
    return;
  }
  typeInput.value = "";
  closeSlashMenu();
  // "/brain" is the command table, not a skill.
  if (isCommandTableAsk(question)) {
    questionEndedAt = performance.now();
    addBubble("user", question, false);
    await answerWithBrain(question);
    return;
  }
  // "/name what to do": turn that skill on, then ask. "/name" alone just turns it on.
  const slash = question.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (slash) {
    const wanted = slash[1].toLowerCase();
    const skill = skillCatalog.find((item) => item.id === wanted)
      || skillCatalog.find((item) => item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === wanted);
    if (!skill) {
      setStatus(`There is no skill called /${slash[1]}. Type / to see them.`);
      return;
    }
    setActiveSkill(skill.id);
    question = slash[2].trim();
    if (!question) {
      setStatus(`/${skill.id} is on. Type or say what to do with it.`);
      return;
    }
  }
  if (lectureFormOpen) {
    setStatus("Type the presenter's name and edit the title, then press Write summary.");
    return;
  }
  if (meetingOn) {
    // A typed question is for the brain, not part of the meeting. Answer it on screen.
    answerDuringMeeting(question);
    return;
  }
  // Word is open on the right: the question is about the document there.
  if (window.brainWord?.open) {
    window.brainWord.ask(question);
    return;
  }
  if (window.brainSlides?.open) {
    window.brainSlides.ask(question);
    return;
  }
  questionEndedAt = performance.now();

  // Gemini Live takes typed words on the same line.
  if (gemini?.ready) {
    stopGeminiAudio();
    addBubble("user", question, false);
    gemini.ws.send(JSON.stringify({ realtimeInput: { text: question } }));
    return;
  }

  // The listening loop is already running. Hand it the words and let it answer.
  if (connected && needsVoiceControl(selectedModel())) {
    listenForNewQuestion();
    queuedQuestion = question;
    return;
  }

  if (brainBusy || connected) listenForNewQuestion();
  while (brainBusy) await sleep(40);
  addBubble("user", question, false);
  await answerWithBrain(question);
}

restartBtn.addEventListener("click", async () => {
  if (!lastQuestion) {
    setStatus("There is no last question yet.");
    return;
  }
  if (paused) {
    paused = false;
    if (micStream) {
      for (const track of micStream.getAudioTracks()) track.enabled = !muted;
    }
  }
  stopSpeaking();
  askAbort?.abort();
  if (!connected) {
    pendingReplay = lastQuestion;
    await startCall();
    return;
  }
  while (brainBusy) await sleep(40);
  questionEndedAt = performance.now();
  addBubble("user", lastQuestion, false);
  await answerWithBrain(lastQuestion);
});

muteBtn.addEventListener("click", () => {
  if (!micStream) return;
  muted = !muted;
  for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
  muteBtn.classList.toggle("is-muted", muted);
  if (connected) {
    if (meetingOn && !muted) {
      setStatus(quietCaptureStatus());
      setCapsuleState(captureRole());
    } else {
      setStatus(muted ? "Mic muted" : "Listening…");
      setCapsuleState(muted ? "idle" : "listening");
    }
  }
});

clearBtn.addEventListener("click", () => clearTranscript());

/** Clear & save: a summary of the conversation goes to brain.md first. Nothing is cleared if that fails. */
saveClearBtn.addEventListener("click", async () => {
  const lines = [...transcriptEl.querySelectorAll(".bubble:not(.partial)")].map((bubble) =>
    `${bubble.querySelector(".who")?.textContent || ""}: ${bubble.querySelector(".text")?.textContent || ""}`);
  if (chatMemory) lines.unshift(`Earlier in this conversation: ${chatMemory}`);
  const text = lines.join("\n").trim();
  if (!text) {
    setStatus("There is no conversation to save yet.");
    return;
  }
  saveClearBtn.disabled = true;
  saveClearBtn.textContent = "Saving…";
  try {
    const response = await fetch("/brain/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save the conversation.");
    clearTranscript();
    setStatus("Saved a summary to brain.md, then cleared.");
  } catch (err) {
    console.error("Failed while saving the conversation:", err);
    setStatus(`${err.message} Nothing was cleared.`);
  } finally {
    saveClearBtn.disabled = false;
    saveClearBtn.textContent = "Clear & save";
  }
});

function clearTranscript() {
  cancelRecapHold();
  transcriptEl.innerHTML = '<p class="empty">Press Start talking and say Hey, or press Command and Control together. You can also type a question below the orb. Turn Meeting on to write down a conversation, or Lecture to write down a talk, without answering.</p>';
  assistantPartialEl = null;
  userPartialEl = null;
  chatTurns = [];
  chatMemory = "";
  savedMeeting = "";
  savedNotesKind = "";
  meetingLines = [];
  latestShot = "";
  latestShotSent = false;
  compressAbort?.abort();
  forgetSavedChat();
}

let chosenModelId = "";
let chatTurns = [];
let chatMemory = "";
let compressAbort = null;
let compressGen = 0;
let localStop = false;

/** Keep a question and its answer for tonight's brain.md summary. */
function logDay(question, answer) {
  if (!String(question || "").trim() || !String(answer || "").trim()) return;
  fetch("/daylog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, answer }),
  }).catch(() => {});
}

function rememberTurn(question, answer) {
  const asked = String(question || "").trim();
  if (!asked) return;
  logDay(asked, answer);
  chatTurns.push({
    question: asked,
    answer: String(answer || "").trim() || "(The answer was stopped.)",
  });
  lastAnswerAt = performance.now();
  if (chatTurns.length > 8) chatTurns = chatTurns.slice(-8);
  persistChat();
}

function compressWhileSpeaking() {
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
    persistChat();
    const last = snapshot[snapshot.length - 1];
    const stillThere = chatTurns.findIndex((turn) => turn.question === last?.question && turn.answer === last?.answer);
    if (stillThere >= 0) chatTurns = chatTurns.slice(stillThere);
  }).catch((err) => {
    if (err?.name === "AbortError") return;
    console.error("Failed while compressing the chat:", err);
  });
}

async function startCall() {
  setBusy(true);
  setStatus("Connecting…");
  setCapsuleState("connecting");
  talkLabel.textContent = "Connecting…";
  chat = emptyChat();
  countedResponses.clear();
  renderChat();
  answerWaits = [];
  questionEndedAt = 0;
  renderWaits();

  // Medical speech stays on this Mac. It never opens Gemini Live.
  // GPT-OSS 20B writes the transcript. The model you picked answers only a real question.
  if (medicalListening()) {
    try {
      await startLocalListen();
    } catch (err) {
      console.error("Failed while starting medical listening:", err);
      setStatus(humanError(err));
      setCapsuleState("idle");
      await hangUp({ keepStatus: true });
      setBusy(false);
    }
    return;
  }

  // Gemini Live hears and speaks on its own line (gemini.js).
  if (selectedModel()?.gemini) {
    try {
      await startGeminiCall();
    } catch (err) {
      console.error("Failed while starting Gemini Live:", err);
      setStatus(humanError(err));
      setCapsuleState("idle");
      await hangUp({ keepStatus: true });
    }
    setBusy(false);
    return;
  }

  // Bonsai does not speak. Voice control reads its answer.
  if (needsVoiceControl(selectedModel())) {
    try {
      await startLocalListen();
    } catch (err) {
      console.error("Failed while starting local listening:", err);
      setStatus(humanError(err));
      setCapsuleState("idle");
      await hangUp({ keepStatus: true });
      setBusy(false);
    }
    return;
  }

  try {
    micStream = await openMic();

    pc = new RTCPeerConnection();
    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.play().catch(() => {});
    };
    for (const track of micStream.getTracks()) pc.addTrack(track, micStream);

    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (event) => {
      handleServerEvent(safeParse(event.data));
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 1500);

    const sdpResponse = await fetch(
      `/session?voice=${OPENAI_VOICE}&model=${encodeURIComponent(modelSelect.value)}&reasoning=${encodeURIComponent(reasoningSelect.value)}`,
      {
      method: "POST",
      body: pc.localDescription?.sdp || offer.sdp,
      headers: { "Content-Type": "application/sdp" },
    });
    const answerBody = await sdpResponse.text();
    if (!sdpResponse.ok) {
      let message = answerBody;
      try {
        const parsed = JSON.parse(answerBody);
        message = parsed.details?.error?.message || parsed.error || answerBody;
      } catch {
        /* keep the raw text */
      }
      throw new Error(message || `Session failed (${sdpResponse.status})`);
    }

    await pc.setRemoteDescription({ type: "answer", sdp: answerBody });
    connected = true;
    voiceSelect.disabled = true;
    modelSelect.disabled = true;
    reasoningSelect.disabled = true;
    muteBtn.disabled = false;
    syncCallButtons();
    talkBtn.setAttribute("aria-pressed", "true");
    talkLabel.textContent = "End call";
    setStatus(listenStatus());
    setCapsuleState("listening");
    setBusy(false);
    if (pendingReplay) {
      const again = pendingReplay;
      pendingReplay = "";
      addBubble("user", again, false);
      await answerWithBrain(again);
    }
  } catch (err) {
    console.error("Failed while starting the call:", err);
    setStatus(humanError(err));
    setCapsuleState("idle");
    await hangUp({ keepStatus: true });
    setBusy(false);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

