/**
 * Voice window for the second brain.
 *
 * Voice-control models (Voice mini, Voice) hear the microphone themselves.
 * Bonsai and the GPT-6 models cannot hear. For those, this Mac writes
 * down your words with the local voice model, the chosen model writes
 * the answer, and Voice mini (voice control) is the only voice that
 * speaks it. The microphone is not sent to OpenAI.
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
const skillFile = document.getElementById("skillFile");
const uploadSkillBtn = document.getElementById("uploadSkillBtn");
const folderPath = document.getElementById("folderPath");
const addFolderBtn = document.getElementById("addFolderBtn");
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

async function askTyped(raw) {
  const question = String(raw || "").trim();
  if (!question) {
    typeInput.focus();
    return;
  }
  typeInput.value = "";
  if (lectureFormOpen) {
    setStatus("Type the presenter's name and edit the title, then press Write summary.");
    return;
  }
  if (meetingOn) {
    addMeetingLine(question);
    const where = captureKind === "lecture" ? "lecture" : "meeting";
    setStatus(`Added to the ${where}. I'm still only listening.`);
    setCapsuleState(captureRole());
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

clearBtn.addEventListener("click", () => {
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
});

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
      `/session?voice=${encodeURIComponent(voiceSelect.value)}&model=${encodeURIComponent(modelSelect.value)}&reasoning=${encodeURIComponent(reasoningSelect.value)}`,
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

const WAKE_STATUS = "Listening. Say Hey, or press Command and Control together, then your question.";
const KEY_WAKE_STATUS = "Go ahead. I'm listening. You do not need to say Hey.";
/** The line to show while waiting: the key, or the normal Hey reminder. */
function listenStatus() {
  return keyboardWake ? KEY_WAKE_STATUS : wakeStatus();
}
/** The listening line, plus who is writing down your words right now. */
function wakeStatus() {
  if (medicalListening()) {
    return "Medical speech. Whisper hears English and Arabic, with no Hey. GPT-OSS keeps only the medical words, in English, with names removed. A question for me goes to the brain.";
  }
  if (jevListening()) {
    return wakeSelect.value === "jev"
      ? "Listening. Say Hey, or just talk; Jev decides what is for me. (text goes to TypeSafe)"
      : "Listening. Say Hey, or just talk; Gemma on this Mac decides what is for me.";
  }
  // Voice mini hears you itself, so no listener runs on this page.
  if (!needsVoiceControl(selectedModel())) return WAKE_STATUS;
  const who = earsSelect.value === "whisper"
    ? "Whisper on this Mac, English only"
    : earsSelect.value === "whisper-both"
      ? "Whisper twice, English and Arabic, both lines shown"
      : "Whisper, English + Arabic";
  return `${WAKE_STATUS} (${who})`;
}
// A short breath is not the end of the sentence. Wait this long before stopping the recording.
const END_PAUSE_MS = 1200;

/**
 * The words after "Hey", or null when the sentence does not start with Hey.
 * "Hey my brain" still works. An empty string means they said only Hey.
 */
function questionAfterWake(text) {
  const cleaned = String(text || "").replace(/^[\s"'“”]+/, "").trim();
  // Arabic openers too: هاي (hey), يا دماغي (hey my brain).
  const match = cleaned.match(/^(?:hey\b(?:\s+my\s+brain\b)?|هاي|يا\s*دماغي)[\s,.:;!?،\-]*/i);
  if (!match) return null;
  return cleaned.slice(match[0].length).trim();
}

/**
 * The question after Hey, looking at each line.
 * The two-whisper option starts a line with "English:" or "Arabic:".
 */
function questionFromHeard(text) {
  const raw = String(text || "");
  const lines = /^(?:English|Arabic):/im.test(raw)
    ? raw.split("\n").map((line) => line.replace(/^(?:English|Arabic):\s*/i, "").trim())
    : [raw];
  for (const line of lines) {
    const question = questionAfterWake(line);
    if (question) return question;
  }
  return null;
}

/**
 * The sentence to answer after Command and Control together.
 * Hey at the start is still removed. Null means the clip was only noise, so the key stays armed.
 */
function wordsFromKey(text) {
  const raw = String(text || "");
  const lines = /^(?:English|Arabic):/im.test(raw)
    ? raw.split("\n").map((line) => line.replace(/^(?:English|Arabic):\s*/i, "").trim()).filter(Boolean)
    : [raw.trim()];
  for (const line of lines) {
    if (!line || looksLikeSilence(line)) continue;
    const after = questionAfterWake(line);
    if (after !== null) return after;
    return line;
  }
  return null;
}

/** Whisper sometimes invents these on a quiet room. Ignore them. */
function looksLikeSilence(text) {
  const raw = String(text || "").trim();
  // A whole caption in parentheses is a sound, such as (door opens) or (sighs).
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .trim();
  if (cleaned.length < 2) return true;
  const junk = [
    "thank you",
    "thanks for watching",
    "you",
    "bye",
    "silence",
    "music",
    "blank audio",
    "door opens",
    "door closing",
    "sighs",
    "sigh",
    "coughing",
    "laughter",
    "background noise",
  ];
  return junk.includes(cleaned);
}

/**
 * Record until the person stops talking.
 * The clip stays on this Mac. It is not sent to the voice-control model.
 */
function recordUntilSilence(stream) {
  const epoch = listenEpoch;
  recordingClip = true;
  return new Promise((resolve) => {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    let settled = false;
    let discard = false;
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
      recordingClip = false;
      if (settled) return;
      settled = true;
      resolve(discard ? new Blob() : new Blob(chunks, { type: mime }));
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
    rec.start();

    const timer = setInterval(() => {
      if (epoch !== listenEpoch) {
        // Turning Meeting off keeps this last sentence. Stop and a new question throw it away.
        discard = !closeMeetingAfterClip;
        finish();
        return;
      }
      if (localStop || !connected) {
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
        // They started again, so this pause was not the end of the question.
        if (quietSince) clearThinkCue();
        quietSince = 0;
      } else if (heard && now - started > 400) {
        if (!quietSince) {
          quietSince = now;
          // First beep is half a second after the voice goes quiet.
          armThinkCue(quietSince);
        }
        if (now - quietSince > END_PAUSE_MS) {
          questionEndedAt = quietSince;
          finish();
        }
      }
      if (now - started > 45000) {
        questionEndedAt = now;
        finish();
      }
    }, 80);

    function finish() {
      clearInterval(timer);
      try { source.disconnect(); } catch { /* already disconnected */ }
      ctx.close().catch(() => {});
      if (rec.state !== "inactive") rec.stop();
      else if (!settled) {
        recordingClip = false;
        settled = true;
        resolve(new Blob());
      }
    }
  });
}

async function transcribeClip(clip, meeting) {
  // A meeting always uses the model that can write Arabic and English together.
  // both: English whisper and Arabic whisper listen to the same clip.
  // any: one whisper picks the language. English only cannot write Arabic.
  const query = meeting
    ? "?lang=any"
    : earsSelect.value === "whisper-both"
    ? "?lang=both"
    : earsSelect.value === "whisper" && !medicalListening()
      ? ""
      : "?lang=any";
  const response = await fetch(`/transcribe${query}`, {
    method: "POST",
    headers: { "Content-Type": clip.type || "audio/webm" },
    body: clip,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The local voice model could not hear that.");
  return (data.text || "").trim();
}

// Kept so an old pause timer can wake the loop. Chrome no longer listens.
let heardWake = null;
let cutThisSentence = false;

// Said at the start of a sentence while the answer plays.
const CUT_WORDS = /^(hey|stop|enough|cancel|quiet|be quiet|shut up|ok(ay)? stop)\b/i;

function stopEars() {
  heardWake?.();
}

/**
 * Jev listening (server: jev.js). Each finished sentence without Hey is sent as text to
 * /jev/judge, which answers send / hold / ask / ignore.
 */
let jevHeld = { text: "", at: 0 };
let jevHoldTimer = 0;
// A held sentence with no continuation after this pause is answered as it is.
const JEV_HOLD_MS = 2500;
let jevEarlier = [];
let lastAnswerAt = 0;

/** Hey + Jev or Hey + Gemma: sentences without Hey are judged. Works with every listener. */
function jevListening() {
  return wakeSelect.value === "jev" || wakeSelect.value === "gemma";
}

/** Medical speech: every sentence goes to GPT-OSS 20B. Hey is not required. */
function medicalListening() {
  return wakeSelect.value === "medical";
}

/** The local model takes a while to load the first time. Load the one in use now. */
function warmJudge() {
  if (wakeSelect.value === "gemma") fetch("/jev/warm", { method: "POST" }).catch(() => {});
  if (wakeSelect.value === "medical") fetch("/medgem/warm", { method: "POST" }).catch(() => {});
  // The bigger whisper is slow to load the first time. Start it before they talk.
  if (earsSelect.value === "whisper-both") {
    fetch("/transcribe/warm?lang=both", { method: "POST" }).catch(() => {});
  } else if (wakeSelect.value === "medical" || earsSelect.value !== "whisper") {
    fetch("/transcribe/warm", { method: "POST" }).catch(() => {});
  }
}

/**
 * Send one heard sentence to GPT-OSS 20B.
 * Returns the cleaned English note and, only when it heard a real question, that question.
 */
async function medicalTurn(heard) {
  const raw = String(heard?.text || "").trim();
  if (!raw || looksLikeSilence(raw)) return null;
  setStatus("GPT-OSS is keeping the medical part…");
  setCapsuleState("thinking");
  let data;
  try {
    const response = await fetch("/medgem/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: raw.slice(0, 4000) }),
    });
    data = await response.json();
    if (!response.ok) throw new Error(data.error || "GPT-OSS did not answer.");
  } catch (err) {
    console.error("Failed while cleaning medical speech:", err);
    setStatus("GPT-OSS is not ready. Try that again in a moment.");
    return null;
  }
  const english = String(data.english || "").trim();
  const question = String(data.question || "").trim();
  if (!data.medical || (!english && !question)) return null;
  return { english, question };
}

/** Show the cleaned transcript. This is a note, not a question for the brain. */
function showMedicalNote(text) {
  const bubble = addBubble("note", text, false);
  bubble.querySelector(".who").textContent = "Medical";
  return bubble;
}

/** The question to answer, or "" when Jev says this sentence was not for the assistant. */
async function jevQuestion(heard) {
  // Words held as "cut off" join the next sentence if it comes within 10 seconds.
  const text = jevHeld.text && heard.at - jevHeld.at < 10000 ? `${jevHeld.text} ${heard.text}` : heard.text;
  jevHeld = { text: "", at: 0 };
  clearTimeout(jevHoldTimer);
  let verdict;
  try {
    const response = await fetch("/jev/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latest: text,
        backend: wakeSelect.value === "jev" ? "typesafe" : "gemma",
        earlier: jevEarlier.slice(-3),
        lastAnswer: chatTurns.at(-1)?.answer || "",
        justAnswered: Boolean(lastAnswerAt) && performance.now() - lastAnswerAt < 20000,
      }),
    });
    verdict = await response.json();
    if (!response.ok) throw new Error(verdict.error || `Jev returned ${response.status}`);
  } catch (err) {
    console.error("Failed while asking Jev:", err);
    setStatus("Jev is not answering. Say Hey to ask a question.");
    return "";
  } finally {
    jevEarlier = [...jevEarlier, text].slice(-5);
  }
  if (verdict.decision === "send") return text;
  if (verdict.decision === "hold") {
    jevHeld = { text, at: heard.at };
    jevHoldTimer = setTimeout(() => {
      if (jevHeld.text !== text || brainBusy) return;
      jevHeld = { text: "", at: 0 };
      queuedQuestion = text;
      heardWake?.();
    }, JEV_HOLD_MS);
  }
  if (verdict.decision === "ask") offerJevQuestion(text);
  return "";
}

/** Jev was not sure. Show the sentence with a button; one tap asks it. */
function offerJevQuestion(text) {
  const bubble = addBubble("user", text, true);
  bubble.querySelector(".who").textContent = "Was that for me?";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn";
  button.textContent = "Yes, answer it";
  button.addEventListener("click", () => {
    // The listening loop shows the question again when it answers it.
    bubble.remove();
    queuedQuestion = text;
    heardWake?.();
  }, { once: true });
  bubble.append(button);
}

/** The speaker's own voice can reach the mic. A long phrase taken from the answer is an echo. */
function isEcho(text) {
  const answer = (currentAnswerBubble?.textContent || "").toLowerCase();
  const words = text.toLowerCase().split(/\s+/);
  return words.length >= 3 && answer.includes(words.slice(0, 4).join(" "));
}

function heardWords(text) {
  if (muted || !brainBusy || cutThisSentence) return;
  if (!CUT_WORDS.test(text) || isEcho(text)) return;
  cutThisSentence = true;
  stopSpeaking();
  cancelAnswer = true;
  askAbort?.abort();
  try { activeReader?.cancel(); } catch { /* already finished */ }
  if (/^hey\b/i.test(text)) {
    setStatus("Go ahead. A short pause is fine.");
  } else {
    setStatus("Stopped. Say Hey for a new question.");
  }
  setCapsuleState("listening");
}

// Chrome and Google cloud only heard English. A saved choice of either becomes English + Arabic.
const savedEars = localStorage.getItem("ears");
earsSelect.value = savedEars === "whisper" || savedEars === "whisper-both" ? savedEars : "whisper-auto";
if (!earsSelect.value) earsSelect.value = "whisper-auto";
localStorage.setItem("ears", earsSelect.value);
wakeSelect.value = localStorage.getItem("wake") || "hey";
if (!wakeSelect.value) wakeSelect.value = "hey";
wakeSelect.addEventListener("change", () => {
  localStorage.setItem("wake", wakeSelect.value);
  warmJudge();
  if (connected && needsVoiceControl(selectedModel())) setStatus(listenStatus());
});
earsSelect.addEventListener("change", () => {
  localStorage.setItem("ears", earsSelect.value);
  warmJudge();
  if (connected && needsVoiceControl(selectedModel())) setStatus(listenStatus());
});
warmJudge();

// The Mac offers many microphones (this computer, an iPhone nearby, Teams, and so on).
// The menu below is the only way a call picks one. "local" is this Mac. "iphone" is the phone.
micSelect.value = localStorage.getItem("micSource") === "iphone" ? "iphone" : "local";
localStorage.setItem("micSource", micSelect.value);
micSelect.addEventListener("change", async () => {
  const next = chosenMic();
  const previousChoice = localStorage.getItem("micSource") === "iphone" ? "iphone" : "local";
  localStorage.setItem("micSource", next);
  if (!connected && !micStream) {
    setStatus(next === "iphone"
      ? "Next call will use your iPhone. Unlock it and keep it nearby."
      : "Next call will use the microphone on this Mac.");
    return;
  }
  micSelect.disabled = true;
  try {
    await useChosenMic();
    setStatus(next === "iphone" ? "Now listening on your iPhone." : "Now listening on this Mac.");
  } catch (err) {
    micSelect.value = previousChoice;
    localStorage.setItem("micSource", previousChoice);
    console.error("Failed while switching the microphone:", err);
    setStatus(humanError(err));
  } finally {
    micSelect.disabled = false;
  }
});
navigator.mediaDevices?.addEventListener("devicechange", () => {
  labelMicChoices().catch(() => {});
});
labelMicChoices().catch(() => {});

/** "iphone", "local" (this Mac), or "other" (Teams, Zoom, and similar apps). */
function micKind(device) {
  const label = device.label || "";
  if (/iphone/i.test(label)) return "iphone";
  if (/teams|zoom|blackhole|aggregate|loopback|virtual|cable|obs |krisp/i.test(label)) return "other";
  return "local";
}

function chosenMic() {
  return micSelect.value === "iphone" ? "iphone" : "local";
}

/** The real device id, not Chrome's extra "default" copy of the same microphone. */
function realInputs(devices) {
  return devices.filter((device) => (
    device.kind === "audioinput"
    && device.deviceId
    && device.deviceId !== "default"
    && device.deviceId !== "communications"
  ));
}

function pickMic(inputs, choice) {
  if (choice === "iphone") return inputs.find((device) => micKind(device) === "iphone") || null;
  const builtIn = inputs.find((device) => (
    micKind(device) === "local" && /macbook|built-?in|internal/i.test(device.label || "")
  ));
  return builtIn || inputs.find((device) => micKind(device) === "local") || null;
}

function noteMicName(choice, label) {
  const option = micSelect.querySelector(`option[value="${choice}"]`);
  if (!option || !label) return;
  const nice = label.replace(/\s*\(Built-in\)/i, "").trim();
  option.textContent = choice === "iphone" ? `iPhone (${nice})` : `Local (${nice})`;
}

/** Fill the menu with the real names, once the browser is allowed to see them. */
async function labelMicChoices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const inputs = realInputs(await navigator.mediaDevices.enumerateDevices());
  const iphone = inputs.find((device) => micKind(device) === "iphone");
  const local = pickMic(inputs, "local");
  if (iphone) noteMicName("iphone", iphone.label);
  if (local) noteMicName("local", local.label);
}

/**
 * Open the microphone the user picked.
 * Names stay hidden until the first allow, so a short listen unlocks the list, then we open the right one.
 */
async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This window cannot use a microphone.");
  }
  const choice = chosenMic();
  let inputs = realInputs(await navigator.mediaDevices.enumerateDevices());
  if (!inputs.length || inputs.every((device) => !device.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((track) => track.stop());
    inputs = realInputs(await navigator.mediaDevices.enumerateDevices());
  }
  const device = pickMic(inputs, choice);
  if (!device) {
    throw new Error(choice === "iphone"
      ? "No iPhone microphone. Unlock your iPhone, keep it nearby, then try again."
      : "No microphone on this Mac. Check Sound in System Settings, then try again.");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    console.error("Failed while opening the chosen microphone:", err);
    throw new Error(choice === "iphone"
      ? "The iPhone microphone did not open. Unlock your iPhone and try again."
      : "The Mac microphone did not open. Check Sound in System Settings, then try again.");
  }
  noteMicName(choice, device.label);
  return stream;
}

/** Swap the live call onto the microphone picked in the menu. */
async function useChosenMic() {
  const stream = await openMic();
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("The microphone opened with no sound.");
  }
  track.enabled = !muted;
  const previous = micStream;
  try {
    if (pc) {
      const sender = pc.getSenders().find((item) => item.track && item.track.kind === "audio");
      if (sender) await sender.replaceTrack(track);
    }
    if (typeof retargetGeminiMic === "function") retargetGeminiMic(stream);
  } catch (err) {
    stream.getTracks().forEach((item) => item.stop());
    console.error("Failed while attaching the new microphone:", err);
    throw err;
  }
  micStream = stream;
  if (previous && previous !== stream) previous.getTracks().forEach((item) => item.stop());
  return stream;
}

/**
 * While an answer is playing, listen for Hey.
 * Hey stops the voice. The rest of that sentence, including a short pause, becomes the next question.
 */
function watchWhileAnswering(stream) {
  if (!stream || micBusy) return;
  micBusy = true;
  try {
  const epoch = listenEpoch;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  let heyIndex = -1;
  let stopped = false;
  let transcribing = false;
  let pendingSlice = null;
  let sliceLoud = false;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  function level() {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
  }

  async function pump() {
    if (transcribing || !pendingSlice || heyIndex >= 0 || stopped) return;
    transcribing = true;
    const job = pendingSlice;
    pendingSlice = null;
    try {
      const text = await transcribeClip(job.blob);
      if (stopped || epoch !== listenEpoch || heyIndex >= 0) return;
      if (questionFromHeard(text) === null && !/\bhey\b|هاي/i.test(text)) return;
      heyIndex = job.index;
      stopSpeaking();
      cancelAnswer = true;
      askAbort?.abort();
      try { activeReader?.cancel(); } catch { /* already finished */ }
      setStatus("Go ahead. A short pause is fine.");
      setCapsuleState("listening");
    } catch (err) {
      console.error("Failed while listening for Hey:", err);
    } finally {
      transcribing = false;
      if (pendingSlice && heyIndex < 0) pump();
    }
  }

  rec.ondataavailable = (event) => {
    if (!event.data?.size) return;
    const index = chunks.length;
    chunks.push(event.data);
    if (heyIndex >= 0 || !sliceLoud) {
      sliceLoud = false;
      return;
    }
    sliceLoud = false;
    // Only the first slice carries the WebM header, so later slices ride on it.
    const blob = index === 0 ? event.data : new Blob([chunks[0], event.data], { type: mime });
    pendingSlice = { index, blob };
    pump();
  };

  rec.start(900);

  let quietSince = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    if (level() > 0.02) {
      sliceLoud = true;
      if (quietSince) clearThinkCue();
      quietSince = 0;
    } else if (heyIndex >= 0) {
      if (!quietSince) {
        quietSince = performance.now();
        armThinkCue(quietSince);
      }
    }
    const heardHey = heyIndex >= 0;
    const pauseDone = heardHey && quietSince && performance.now() - quietSince > END_PAUSE_MS;
    const callEnded = epoch !== listenEpoch || !connected || localStop;
    const answerFinished = !brainBusy && !heardHey;
    if (pauseDone) {
      questionEndedAt = quietSince;
      finish(true);
    }
    else if (callEnded || answerFinished) finish(false);
  }, 80);

  function finish(keepQuestion) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    rec.onstop = async () => {
      try { source.disconnect(); } catch { /* already disconnected */ }
      ctx.close().catch(() => {});
      try {
        if (keepQuestion && heyIndex >= 0) {
          const text = await transcribeClip(new Blob(chunks.slice(heyIndex), { type: mime }));
          const question = questionFromHeard(text);
          if (question) queuedQuestion = question;
          else clearThinkCue();
        } else {
          clearThinkCue();
        }
      } catch (err) {
        console.error("Failed while saving the new question:", err);
      } finally {
        micBusy = false;
      }
    };
    if (rec.state !== "inactive") rec.stop();
    else micBusy = false;
  }
  } catch (err) {
    console.error("Failed while listening during the answer:", err);
    micBusy = false;
  }
}

const MEETING_STATUS = "Meeting. I am writing the words as they are said, in Arabic or English.";

/** "Lecture" or "Meeting", for the words on screen. */
function captureName() {
  return captureKind === "lecture" ? "Lecture" : "Meeting";
}

/** The bubble and orb name for the mode that is on. */
function captureRole() {
  return captureKind === "lecture" ? "lecture" : "meeting";
}

/** The line under the orb while words are only being written down. */
function quietCaptureStatus() {
  return `${captureName()}. I'm writing down every word and staying quiet.`;
}

/** Close the presenter form if the call ends before it is submitted. */
function closeLectureForm(value) {
  const settle = settleLectureForm;
  settleLectureForm = null;
  if (settle) settle(value);
}
// How often a meeting line is sent to the listener while people are still talking.
const MEETING_SLICE_MS = 2000;
// Start a new line after this long so the words on screen stay close to the voices.
const MEETING_LINE_MS = 18000;

/** Show Meeting, Lecture, and Recap / Ask as on, off, or unavailable. */
function paintMeetingButton() {
  const lecture = meetingOn && captureKind === "lecture";
  const meeting = meetingOn && captureKind !== "lecture";
  meetingBtn.disabled = !connected || meetingSummaryBusy || lecture;
  lectureBtn.disabled = !connected || meetingSummaryBusy || meeting;
  meetingBtn.setAttribute("aria-pressed", meeting ? "true" : "false");
  lectureBtn.setAttribute("aria-pressed", lecture ? "true" : "false");
  meetingBtn.classList.toggle("is-on", meeting);
  lectureBtn.classList.toggle("is-on", lecture);
  meetingBtn.textContent = meeting ? "Meeting on" : "Meeting";
  lectureBtn.textContent = lecture ? "Lecture on" : "Lecture";
  recapBtn.disabled = !meetingOn || recapBusy;
  recapBtn.title = lecture
    ? "Summarize the talk so far and suggest questions. Shown only, not spoken."
    : "Summarize the meeting so far and suggest questions. Shown only, not spoken.";
}

/** One finished sentence from the meeting. Repeats and room noise are skipped. */
function addMeetingLine(text) {
  const line = String(text || "").trim();
  if (!line || looksLikeSilence(line)) return;
  if (meetingLines.at(-1) === line) return;
  meetingLines.push(line);
  const bubble = addBubble(captureRole(), line, false);
  bubble.querySelector(".who").textContent = captureName();
}

/** Gemini sends a meeting one piece at a time. Keep them in one line until the turn ends. */
function addMeetingPiece(piece) {
  const bit = String(piece || "");
  if (!bit.trim()) return;
  meetingPartial += bit;
  if (!meetingPartialBubble) {
    meetingPartialBubble = addBubble(captureRole(), "", true);
    meetingPartialBubble.querySelector(".who").textContent = captureName();
  }
  meetingPartialBubble.querySelector(".text").textContent = meetingPartial.trim();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/** Close the line Gemini has been building. */
function finishMeetingLine() {
  const line = meetingPartial.trim();
  meetingPartial = "";
  if (meetingPartialBubble) {
    meetingPartialBubble.classList.remove("partial");
    meetingPartialBubble = null;
  }
  if (!line || looksLikeSilence(line)) return;
  if (meetingLines.at(-1) === line) return;
  meetingLines.push(line);
}

function showMeetingStatus() {
  setStatus(captureKind === "lecture"
    ? "Lecture. I am writing the words as they are said, in Arabic or English."
    : MEETING_STATUS);
  setCapsuleState(muted ? "muted" : captureRole());
}

/** Replace the live meeting line with the words heard so far. */
function showMeetingDraft(text) {
  const line = String(text || "").trim();
  if (!line || looksLikeSilence(line)) return;
  meetingPartial = line;
  if (!meetingPartialBubble) {
    meetingPartialBubble = addBubble(captureRole(), line, true);
    meetingPartialBubble.querySelector(".who").textContent = captureName();
  } else {
    meetingPartialBubble.querySelector(".text").textContent = line;
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/** Lock the live line into the transcript. `into` is the list that keeps it. */
function freezeMeetingDraft(text, into) {
  const line = String(text || meetingPartial || "").trim();
  const bubble = meetingPartialBubble;
  meetingPartial = "";
  meetingPartialBubble = null;
  if (!line || looksLikeSilence(line)) {
    bubble?.remove();
    return "";
  }
  if (bubble) {
    bubble.classList.remove("partial");
    bubble.querySelector(".text").textContent = line;
  } else {
    const created = addBubble(captureRole(), line, false);
    created.querySelector(".who").textContent = captureName();
  }
  const list = into || meetingLines;
  if (list.at(-1) !== line) list.push(line);
  return line;
}

/**
 * Write one stretch of the meeting while it is still being said.
 * Every couple of seconds the words so far replace the live line.
 * Arabic and English stay in the language that was spoken.
 * The line closes on a short pause, or after a few seconds, so the next words can start a new line.
 */
function captureMeetingLine(stream) {
  const epoch = listenEpoch;
  recordingClip = true;
  return new Promise((resolve) => {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch (err) {
      recordingClip = false;
      console.error("Failed while opening the meeting recorder:", err);
      resolve("");
      return;
    }
    const chunks = [];
    let latest = "";
    let transcribing = false;
    let pendingBlob = null;
    let stopped = false;
    let settled = false;
    let sliceLoud = false;
    let heard = false;
    let quietSince = 0;
    const started = performance.now();
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    function level() {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const sample = (value - 128) / 128;
        sum += sample * sample;
      }
      return Math.sqrt(sum / samples.length);
    }

    function cleanup() {
      try { source.disconnect(); } catch { /* already disconnected */ }
      ctx.close().catch(() => {});
    }

    function finish() {
      if (settled) return;
      if (transcribing || pendingBlob) return;
      settled = true;
      recordingClip = false;
      cleanup();
      resolve(latest.trim());
    }

    async function pump() {
      if (transcribing || !pendingBlob) return;
      transcribing = true;
      const blob = pendingBlob;
      pendingBlob = null;
      try {
        if (blob.size >= 2000) {
          const text = await transcribeClip(blob, true);
          if (text && !looksLikeSilence(text)) {
            latest = text;
            showMeetingDraft(text);
          }
        }
      } catch (err) {
        console.error("Failed while writing the meeting:", err);
      } finally {
        transcribing = false;
        if (pendingBlob) pump();
        else if (stopped) finish();
      }
    }

    rec.ondataavailable = (event) => {
      if (!event.data?.size) return;
      chunks.push(event.data);
      // A quiet room at the start is not a line. Once someone has spoken, keep updating.
      if (!sliceLoud && !heard) return;
      sliceLoud = false;
      pendingBlob = new Blob(chunks, { type: mime });
      pump();
    };
    rec.onstop = () => {
      if (!transcribing && !pendingBlob) finish();
    };

    function stopRec() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (rec.state !== "inactive") rec.stop();
      else finish();
    }

    const timer = setInterval(() => {
      if (epoch !== listenEpoch || !connected || localStop || !meetingOn) {
        stopRec();
        return;
      }
      const now = performance.now();
      if (level() > 0.025) {
        heard = true;
        sliceLoud = true;
        quietSince = 0;
      } else if (heard) {
        if (!quietSince) quietSince = now;
        if (now - quietSince > END_PAUSE_MS) stopRec();
      }
      if (heard && now - started > MEETING_LINE_MS) stopRec();
    }, 80);

    try {
      rec.start(MEETING_SLICE_MS);
    } catch (err) {
      console.error("Failed while starting the meeting recorder:", err);
      stopRec();
    }
  });
}

/**
 * Turn Meeting or Lecture on in the middle of a call.
 * Any answer that is playing stops. From here, speech is only written down.
 */
function beginMeeting(kind = "meeting") {
  if (!connected || meetingOn || lectureFormOpen) return;
  captureKind = kind === "lecture" ? "lecture" : "meeting";
  closeMeetingAfterClip = false;
  linesToSummarize = null;
  meetingSummaryBusy = false;
  meetingOn = true;
  meetingStartedAt = Date.now();
  meetingLines = [];
  capturePhotos = [];
  meetingPartial = "";
  if (meetingPartialBubble) {
    meetingPartialBubble.remove();
    meetingPartialBubble = null;
  }
  paintMeetingButton();
  const interrupt = brainBusy || micBusy;
  stopSpeaking();
  if (interrupt) {
    listenEpoch += 1;
    cancelAnswer = true;
    askAbort?.abort();
    try { activeReader?.cancel(); } catch { /* the answer already finished */ }
    queuedQuestion = "";
  }
  const offWord = captureName();
  const bubble = addBubble(captureRole(), `Listening. Arabic and English are written as they are said. I will stay quiet until you turn ${offWord} off.`, false);
  bubble.querySelector(".who").textContent = offWord;
  // Load the listener that can write both languages before the first words arrive.
  fetch("/transcribe/warm", { method: "POST" }).catch(() => {});
  showMeetingStatus();
  syncCallButtons();
}

/**
 * Turn Meeting off. The last sentence is kept, then the meeting is summarized.
 * The local listening loop speaks the summary when it is the one holding the mic.
 */
function endMeeting() {
  if (!meetingOn || meetingSummaryBusy) return;
  finishMeetingLine();
  meetingOn = false;
  meetingEndedAt = Date.now();
  paintMeetingButton();
  // Keep these lines even if a new recording is still finishing.
  linesToSummarize = meetingLines.slice();
  meetingLines = [];
  photosToSave = capturePhotos.slice();
  capturePhotos = [];
  closeMeetingAfterClip = true;
  stopSpeaking();
  setStatus(captureKind === "lecture" ? "Lecture off. Add the presenter and a title." : "Meeting off. Writing the minutes…");
  setCapsuleState("thinking");
  if (recordingClip) listenEpoch += 1;
  if (localEars) return;
  closeMeetingAfterClip = false;
  speakMeetingSummary();
}

meetingBtn.addEventListener("click", () => {
  if (!connected || meetingSummaryBusy || lectureFormOpen) return;
  if (meetingOn && captureKind !== "lecture") endMeeting();
  else if (!meetingOn) beginMeeting("meeting");
});

lectureBtn.addEventListener("click", () => {
  if (!connected || meetingSummaryBusy || lectureFormOpen) return;
  if (meetingOn && captureKind === "lecture") endMeeting();
  else if (!meetingOn) beginMeeting("lecture");
});

/**
 * Recap the meeting so far and suggest questions. Shown only, never spoken.
 * Reads a copy of the lines, so the minutes are written exactly as before.
 */
recapBtn.addEventListener("click", async () => {
  if (!meetingOn || recapBusy) return;
  const lines = meetingLines.slice();
  if (meetingPartial.trim()) lines.push(meetingPartial.trim());
  const bubble = addBubble("recap", lines.length ? "Writing a recap…" : "Nothing has been written down yet.", false);
  bubble.querySelector(".who").textContent = "Recap";
  if (!lines.length) return;
  recapBusy = true;
  recapBtn.disabled = true;
  try {
    const response = await fetch("/meeting/recap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: lines.join("\n"),
        model: modelSelect.value,
        kind: captureKind === "lecture" ? "lecture" : "meeting",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not write the recap.");
    bubble.querySelector(".text").textContent = data.text;
  } catch (err) {
    console.error("Failed while writing the meeting recap:", err);
    bubble.querySelector(".text").textContent = err.message || "Could not write the recap.";
  } finally {
    recapBusy = false;
    recapBtn.disabled = !meetingOn;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
});

/** The photo to send with this question, or "" when the question is not about a picture. */
function photoForQuestion(question) {
  if (!latestShot) return "";
  const aboutPicture = /\b(photo|picture|image|slide|slides|screen|whiteboard|chart|figure|diagram)\b/i.test(question);
  const firstAsk = !latestShotSent && Date.now() - latestShotAt < 3 * 60 * 1000;
  if (!aboutPicture && !firstAsk) return "";
  latestShotSent = true;
  return latestShot;
}

/** Words for a camera that would not open. */
function cameraError(err) {
  const msg = `${err?.name || ""} ${err?.message || err || ""}`;
  if (/Permission|NotAllowed/i.test(msg)) return "Camera permission was denied. Allow the camera for this window, then press Photo again.";
  if (/NotFound|not found|DevicesNotFound/i.test(msg)) return "No camera was found. Unlock your iPhone, keep it nearby, then press Photo again.";
  return "The camera did not open. Unlock your iPhone and keep it nearby, then try again.";
}

/** Turn the camera light off and hide the preview. */
function stopPhotoCamera() {
  photoStream?.getTracks().forEach((track) => track.stop());
  photoStream = null;
  if (photoVideo) photoVideo.srcObject = null;
}

/** Cameras the browser can open. Skip Chrome's "default" copy of the Mac camera. */
function listCameras(devices) {
  return devices.filter((device) => (
    device.kind === "videoinput"
    && device.deviceId
    && device.deviceId !== "default"
    && device.deviceId !== "communications"
  ));
}

/**
 * The iPhone camera, when the phone is unlocked and nearby.
 * The name may be "iPhone Camera", or it may only share a group with the iPhone microphone.
 */
function phoneCamera(devices) {
  const cameras = listCameras(devices);
  const main = cameras.find((camera) => (
    /iphone|continuity/i.test(camera.label || "") && !/desk view/i.test(camera.label || "")
  ));
  if (main) return main;
  const phoneGroups = new Set(
    devices
      .filter((device) => device.kind === "audioinput" && /iphone/i.test(device.label || ""))
      .map((device) => device.groupId)
      .filter(Boolean),
  );
  const byGroup = cameras.find((camera) => camera.groupId && phoneGroups.has(camera.groupId) && !/desk view/i.test(camera.label || ""));
  if (byGroup) return byGroup;
  return cameras.find((camera) => /desk view/i.test(camera.label || "")) || null;
}

/** Ask for camera permission, then release it so the iPhone camera can appear. */
async function allowCameraNames() {
  const first = await navigator.mediaDevices.enumerateDevices();
  if (first.some((device) => device.kind === "videoinput" && device.label)) return first;
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  probe.getTracks().forEach((track) => track.stop());
  await sleep(500);
  return navigator.mediaDevices.enumerateDevices();
}

/** Put every camera in the menu. The iPhone is first. Returns that camera, or null. */
function fillCameraMenu(devices) {
  const cameras = listCameras(devices);
  const phone = phoneCamera(devices);
  const ordered = phone ? [phone, ...cameras.filter((camera) => camera.deviceId !== phone.deviceId)] : cameras;
  // Filling the menu can fire a change for the Mac camera. Ignore that.
  cameraSelect.dataset.quiet = "1";
  cameraSelect.replaceChildren();
  for (const camera of ordered) {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    const isPhone = phone && camera.deviceId === phone.deviceId;
    option.textContent = isPhone ? `iPhone (${camera.label || "Camera"})` : (camera.label || "This Mac");
    cameraSelect.append(option);
  }
  if (phone) cameraSelect.value = phone.deviceId;
  requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
  return phone;
}

/** Open one camera. An empty id uses whichever camera the Mac offers first. */
async function openPhotoCamera(deviceId) {
  stopPhotoCamera();
  const video = deviceId ? { deviceId: { exact: deviceId } } : true;
  try {
    photoStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    const msg = `${err?.name || ""} ${err?.message || ""}`;
    if (!deviceId || !/Overconstrained|NotFound|not found/i.test(msg)) throw err;
    photoStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { ideal: deviceId } },
      audio: false,
    });
  }
  photoVideo.srcObject = photoStream;
  await photoVideo.play();
}

/** A smaller JPEG of the current camera picture. */
function shotFromVideo(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return "";
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const pen = canvas.getContext("2d");
  if (!pen) return "";
  pen.drawImage(video, 0, 0, canvas.width, canvas.height);
  let quality = 0.72;
  let data = canvas.toDataURL("image/jpeg", quality);
  while (data.length > 1_200_000 && quality > 0.4) {
    quality -= 0.12;
    data = canvas.toDataURL("image/jpeg", quality);
  }
  return data.startsWith("data:image/jpeg") ? data : "";
}

/** Show the picture in the transcript. */
function addPhotoBubble(dataUrl, where) {
  clearEmptyHint();
  const bubble = document.createElement("article");
  bubble.className = `bubble photo ${where}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = where === "lecture" ? "Lecture" : where === "meeting" ? "Meeting" : "Photo";
  const img = document.createElement("img");
  img.className = "shot";
  img.alt = where === "lecture" ? "Photo added to the lecture" : where === "meeting" ? "Photo added to the meeting" : "Photo added to the talk";
  img.src = dataUrl;
  bubble.append(who, img);
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/** Keep this picture with the meeting, the lecture, or the next question. */
function keepPhoto(dataUrl) {
  if (meetingOn) {
    if (capturePhotos.length >= 8) {
      setStatus("This already has 8 photos. Turn it off to save them before taking more.");
      return;
    }
    capturePhotos.push(dataUrl);
    meetingLines.push(`A photo was taken (${capturePhotos.length}).`);
    const where = captureKind === "lecture" ? "lecture" : "meeting";
    addPhotoBubble(dataUrl, where);
    setStatus(where === "lecture"
      ? "Photo added to the lecture. It will be saved with the talk."
      : "Photo added to the meeting. It will be saved with the minutes.");
    return;
  }
  latestShot = dataUrl;
  latestShotAt = Date.now();
  latestShotSent = false;
  addPhotoBubble(dataUrl, "talk");
  setStatus("Photo added. Ask what it shows.");
}

/** Close the camera window without keeping a picture. */
function closePhotoSheet() {
  photoEpoch += 1;
  photoSheet.hidden = true;
  photoBusy = false;
  stopPhotoCamera();
  if (photoHint) photoHint.textContent = "Your iPhone is used when it is unlocked and nearby. Otherwise this Mac’s camera is used.";
}

/** The camera that is showing now. */
function currentCameraId() {
  return photoStream?.getVideoTracks()?.[0]?.getSettings()?.deviceId || "";
}

/**
 * Look for the iPhone camera without holding the Mac camera open.
 * The phone often appears a moment after the Mac camera is released.
 */
async function findPhoneCamera(epoch) {
  let devices = await allowCameraNames();
  if (epoch !== photoEpoch) return null;
  let phone = fillCameraMenu(devices);
  if (phone) return phone;
  if (photoHint) photoHint.textContent = "Looking for your iPhone… unlock it and keep it nearby.";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && epoch === photoEpoch && !photoSheet.hidden) {
    await sleep(400);
    devices = await navigator.mediaDevices.enumerateDevices();
    phone = fillCameraMenu(devices);
    if (phone) return phone;
  }
  return null;
}

/** Switch the open preview to the iPhone when it connects. */
async function usePhoneIfPresent(epoch) {
  if (photoPickedByUser || epoch !== photoEpoch || photoSheet.hidden) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const phone = fillCameraMenu(devices);
  if (!phone || epoch !== photoEpoch || photoSheet.hidden) return;
  if (currentCameraId() === phone.deviceId) {
    cameraSelect.value = phone.deviceId;
    if (photoHint) photoHint.textContent = "Using your iPhone camera.";
    return;
  }
  await openPhotoCamera(phone.deviceId);
  if (epoch !== photoEpoch) {
    stopPhotoCamera();
    return;
  }
  cameraSelect.dataset.quiet = "1";
  cameraSelect.value = phone.deviceId;
  requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
  if (photoHint) photoHint.textContent = "Using your iPhone camera.";
  photoError.hidden = true;
  shutterBtn.disabled = false;
}

/** Open the camera, preferring the iPhone when it is nearby. */
async function startPhotoSheet() {
  if (photoBusy) return;
  photoBusy = true;
  photoPickedByUser = false;
  const epoch = photoEpoch;
  photoError.hidden = true;
  photoError.textContent = "";
  photoSheet.hidden = false;
  shutterBtn.disabled = true;
  cameraSelect.replaceChildren();
  if (photoHint) photoHint.textContent = "Looking for your iPhone… unlock it and keep it nearby.";
  try {
    const phone = await findPhoneCamera(epoch);
    if (epoch !== photoEpoch) return;
    if (phone) {
      await openPhotoCamera(phone.deviceId);
      if (epoch !== photoEpoch) {
        stopPhotoCamera();
        return;
      }
      cameraSelect.dataset.quiet = "1";
      cameraSelect.value = phone.deviceId;
      requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
      if (photoHint) photoHint.textContent = "Using your iPhone camera.";
    } else {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillCameraMenu(devices);
      const mac = listCameras(devices)[0];
      if (!mac) throw new Error("NotFoundError: No camera was found");
      await openPhotoCamera(mac.deviceId);
      if (epoch !== photoEpoch) {
        stopPhotoCamera();
        return;
      }
      cameraSelect.dataset.quiet = "1";
      cameraSelect.value = mac.deviceId;
      requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
      if (photoHint) photoHint.textContent = "The iPhone camera is not connected, so this is the Mac camera. Unlock the phone, keep it nearby, and it will switch over.";
    }
    shutterBtn.disabled = false;
  } catch (err) {
    if (epoch !== photoEpoch) return;
    console.error("Failed while opening the camera:", err);
    photoError.hidden = false;
    photoError.textContent = cameraError(err);
    stopPhotoCamera();
  }
}

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (photoSheet.hidden || !photoBusy) return;
  usePhoneIfPresent(photoEpoch).catch((err) => {
    console.error("Failed while switching to the iPhone camera:", err);
  });
});

photoBtn.addEventListener("click", () => {
  startPhotoSheet();
});

photoCancelBtn.addEventListener("click", closePhotoSheet);

photoSheet.addEventListener("click", (event) => {
  if (event.target === photoSheet) closePhotoSheet();
});

cameraSelect.addEventListener("change", async () => {
  if (cameraSelect.dataset.quiet === "1" || !cameraSelect.value || photoSheet.hidden) return;
  photoPickedByUser = true;
  shutterBtn.disabled = true;
  try {
    await openPhotoCamera(cameraSelect.value);
    photoError.hidden = true;
  } catch (err) {
    console.error("Failed while switching cameras:", err);
    photoError.hidden = false;
    photoError.textContent = cameraError(err);
  } finally {
    shutterBtn.disabled = !photoStream;
  }
});

shutterBtn.addEventListener("click", () => {
  const dataUrl = shotFromVideo(photoVideo);
  if (!dataUrl) {
    photoError.hidden = false;
    photoError.textContent = "The camera has no picture yet. Wait a moment, then try again.";
    return;
  }
  keepPhoto(dataUrl);
  closePhotoSheet();
});

/** Hand the transcript to a model that hears for itself, so it can summarize and remember it. */
function summarizeWithLiveModel() {
  const script = [
    "The meeting is over. Write the minutes, then say them.",
    "Keep Arabic and English as they were spoken. Do not translate.",
    "Cover what the meeting was about, the topics, any decisions, and who will do what.",
    "Do not invent facts that are not written here.",
    "After the minutes, answer questions about this meeting.",
    "",
    savedMeeting.slice(-12000),
  ].join("\n");
  if (gemini?.ready && gemini.ws?.readyState === WebSocket.OPEN) {
    gemini.ws.send(JSON.stringify({ realtimeInput: { text: script } }));
    setStatus("Writing the minutes…");
    setCapsuleState("thinking");
    return true;
  }
  if (selectedModel()?.hears && dc?.readyState === "open") {
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: script }],
      },
    });
    sendEvent({ type: "response.create" });
    setStatus("Writing the minutes…");
    setCapsuleState("thinking");
    return true;
  }
  return false;
}

/** Save the minutes or lecture notes as a Markdown file. With pick, macOS asks for the folder first. */
async function saveMinutes(meeting, pick, row) {
  const buttons = row.querySelectorAll("button");
  const status = row.querySelector(".minutes-saved");
  const lecture = meeting.kind === "lecture";
  let folder = "";
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (pick) {
      const chosen = await fetch("/meeting/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: lecture ? "lecture" : "meeting" }),
      }).then((r) => r.json());
      folder = chosen.folder || "";
      if (!folder) return;
    }
    status.textContent = "Saving…";
    const response = await fetch(lecture ? "/lecture/save" : "/meeting/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...meeting, folder, model: modelSelect.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || (lecture ? "Could not save the lecture." : "Could not save the minutes."));
    const shots = Number(data.photos) || 0;
    status.textContent = shots
      ? `Saved: ${data.path} (${shots === 1 ? "1 photo" : `${shots} photos`})`
      : `Saved: ${data.path}`;
    flashSaved();
  } catch (err) {
    console.error(lecture ? "Failed while saving the lecture:" : "Failed while saving the minutes:", err);
    status.textContent = err.message || (lecture ? "Could not save the lecture." : "Could not save the minutes.");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

/** Two buttons under the notes: save to the usual folder, or pick another folder. */
function attachMinutesButtons(bubble, meeting) {
  const lecture = meeting.kind === "lecture";
  const row = document.createElement("div");
  row.className = "minutes-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost-btn small";
  save.textContent = lecture ? "Save lecture" : "Save minutes";
  save.title = lecture ? "Save as a Markdown file in raw/lectures" : "Save as a Markdown file in raw/meetings";
  const elsewhere = document.createElement("button");
  elsewhere.type = "button";
  elsewhere.className = "ghost-btn small";
  elsewhere.textContent = "Save to…";
  elsewhere.title = "Choose another folder";
  const status = document.createElement("span");
  status.className = "minutes-saved";
  save.addEventListener("click", () => saveMinutes(meeting, false, row));
  elsewhere.addEventListener("click", () => saveMinutes(meeting, true, row));
  row.append(save, elsewhere, status);
  bubble.append(row);
  meetingSaveRow = row;
}

/**
 * Ask who presented, suggest a title, and let the listener edit it.
 * Resolves with { presenter, title }, or null if they skip or the call ends.
 */
function askLectureDetails(notes) {
  const bubble = addBubble("lecture", "Who gave this talk? I will suggest a title you can change.", false);
  const form = document.createElement("form");
  form.className = "lecture-form";

  const presenterLabel = document.createElement("label");
  presenterLabel.append("Presenter");
  const presenterInput = document.createElement("input");
  presenterInput.type = "text";
  presenterInput.maxLength = 80;
  presenterInput.placeholder = "Name of the person speaking";
  presenterInput.autocomplete = "name";
  presenterLabel.append(presenterInput);

  const titleLabel = document.createElement("label");
  titleLabel.append("Title");
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.maxLength = 120;
  titleInput.placeholder = "Suggesting a title…";
  titleLabel.append(titleInput);

  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "minutes-actions";
  const write = document.createElement("button");
  write.type = "submit";
  write.className = "ghost-btn small";
  write.textContent = "Write summary";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "ghost-btn small";
  skip.textContent = "Not now";
  actions.append(write, skip);
  form.append(presenterLabel, titleLabel, error, actions);
  bubble.append(form);
  presenterInput.focus();

  // A title the listener already typed is kept when the suggestion arrives.
  let titleEdited = false;
  titleInput.addEventListener("input", () => { titleEdited = true; });
  fetch("/lecture/title", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: notes, model: modelSelect.value }),
  })
    .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || titleEdited || !data.title) {
        if (!titleInput.value) titleInput.placeholder = "Type a title";
        return;
      }
      titleInput.value = data.title;
    })
    .catch((err) => {
      console.error("Failed while suggesting a lecture title:", err);
      if (!titleInput.value) titleInput.placeholder = "Type a title";
    });

  return new Promise((resolve) => {
    settleLectureForm = (value) => {
      write.disabled = true;
      skip.disabled = true;
      presenterInput.disabled = true;
      titleInput.disabled = true;
      resolve(value);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const presenter = presenterInput.value.trim();
      const title = titleInput.value.trim();
      if (!presenter) {
        error.hidden = false;
        error.textContent = "Type the presenter's name.";
        presenterInput.focus();
        return;
      }
      error.hidden = true;
      closeLectureForm({ presenter, title });
    });
    skip.addEventListener("click", () => closeLectureForm(null));
  });
}

/** Write the talk summary, say it, and keep the exact words for later questions. */
async function summarizeLecture(lines, photos = []) {
  savedMeeting = lines.join("\n");
  savedNotesKind = "lecture";
  lectureFormOpen = true;
  paintMeetingButton();
  setStatus("Lecture off. Type the presenter's name and edit the title, then press Write summary.");
  setCapsuleState(connected ? (muted ? "muted" : "listening") : "idle");
  const details = await askLectureDetails(savedMeeting);
  lectureFormOpen = false;
  if (!details) {
    if (photos.length) {
      meetingToSave = {
        lines: savedMeeting,
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
        minutes: savedMeeting,
        kind: "lecture",
        presenter: "",
        title: "Lecture",
        photos,
      };
      const note = addBubble("lecture", "The summary was skipped. The photos can still be saved.", false);
      attachMinutesButtons(note, meetingToSave);
    }
    setStatus(connected
      ? "Lecture off. The words are kept. Say Hey to ask about the talk."
      : "Lecture off. The words are kept.");
    if (connected && !localStop) setCapsuleState(muted ? "muted" : "listening");
    return;
  }
  meetingToSave = {
    lines: savedMeeting,
    startedAt: meetingStartedAt,
    endedAt: meetingEndedAt,
    minutes: "",
    kind: "lecture",
    presenter: details.presenter,
    title: details.title,
    photos,
  };
  const count = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const photoNote = photos.length === 1 ? " and 1 photo" : photos.length ? ` and ${photos.length} photos` : "";
  const note = addBubble("lecture", `Wrote down ${count}${photoNote}. Writing the talk summary now.`, false);
  attachMinutesButtons(note, meetingToSave);
  while (brainBusy) await sleep(40);
  if (meetingOn || !connected) return;
  paused = false;
  addBubble("user", "Write the summary of this talk.", false);
  await answerWithBrain("Write the summary of the talk that was just written down.", {
    summarizeLecture: true,
    presenter: details.presenter,
    title: details.title,
  });
}

/** Write the minutes, say them, and keep the exact words for later questions. */
async function speakMeetingSummary() {
  if (meetingSummaryBusy) return;
  const kind = captureKind;
  let lines = Array.isArray(linesToSummarize) ? linesToSummarize : meetingLines.slice();
  const photos = photosToSave.slice();
  photosToSave = [];
  linesToSummarize = null;
  meetingLines = [];
  if (!lines.length && photos.length) lines = ["A photo was taken. No words were written down."];
  if (!lines.length) {
    captureKind = "";
    paintMeetingButton();
    const name = kind === "lecture" ? "Lecture" : "Meeting";
    setStatus(connected ? `${name} off. I did not catch any words. Say Hey when you have a question.` : `${name} off. I did not catch any words.`);
    setCapsuleState(connected ? (muted ? "muted" : "listening") : "idle");
    return;
  }
  if (kind === "lecture") {
    meetingSummaryBusy = true;
    syncCallButtons();
    try {
      await summarizeLecture(lines, photos);
    } finally {
      meetingSummaryBusy = false;
      lectureFormOpen = false;
      captureKind = "";
      syncCallButtons();
    }
    return;
  }
  captureKind = "";
  savedNotesKind = "";
  savedMeeting = lines.join("\n");
  const count = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const photoNote = photos.length === 1 ? " and 1 photo" : photos.length ? ` and ${photos.length} photos` : "";
  const note = addBubble("meeting", `Wrote down ${count}${photoNote}. Writing the minutes now.`, false);
  note.querySelector(".who").textContent = "Meeting";
  meetingToSave = { lines: savedMeeting, startedAt: meetingStartedAt, endedAt: meetingEndedAt, minutes: "", photos };
  attachMinutesButtons(note, meetingToSave);
  meetingSummaryBusy = true;
  syncCallButtons();
  try {
    if (summarizeWithLiveModel()) return;
    while (brainBusy) await sleep(40);
    if (meetingOn || !connected) return;
    paused = false;
    addBubble("user", "Write the minutes of this meeting.", false);
    await answerWithBrain("Write the minutes of the meeting that was just written down.", { summarizeMeeting: true });
  } finally {
    meetingSummaryBusy = false;
    syncCallButtons();
  }
}

/**
 * Bonsai and GPT-6: the Mac listens, that model writes, voice control speaks.
 */
async function startLocalListen() {
  localStop = false;
  localEars = true;
  micStream = await openMic();
  connected = true;
  voiceSelect.disabled = true;
  modelSelect.disabled = true;
  reasoningSelect.disabled = true;
  muteBtn.disabled = false;
  syncCallButtons();
  talkBtn.setAttribute("aria-pressed", "true");
  talkLabel.textContent = "End call";
  const macOnly = Boolean(selectedModel()?.local);
  setStatus(listenStatus());
  setCapsuleState("listening");
  setBusy(false);
  warmJudge();
  // Open voice control now, while you talk, so the first answer starts sooner.
  // Local models use the Kokoro voice, so OpenAI is not needed at all.
  if (!macOnly) ensureSpeaker().catch(() => {});

  if (pendingReplay) {
    const again = pendingReplay;
    pendingReplay = "";
    addBubble("user", again, false);
    await answerWithBrain(again);
  }

  while (connected && !localStop) {
    while (micBusy) await sleep(40);
    if (!connected || localStop) break;
    if (closeMeetingAfterClip && !meetingOn && !recordingClip) {
      closeMeetingAfterClip = false;
      await speakMeetingSummary();
      continue;
    }
    if (queuedQuestion) {
      const question = queuedQuestion;
      queuedQuestion = "";
      if (meetingOn) {
        addMeetingLine(question);
        continue;
      }
      addBubble("user", question, false);
      await answerWithBrain(question);
      continue;
    }
    if (paused) {
      await sleep(250);
      continue;
    }
    if (muted) {
      setStatus("Muted");
      setCapsuleState("muted");
      await sleep(250);
      continue;
    }
    if (meetingOn) {
      showMeetingStatus();
      const heard = await captureMeetingLine(micStream);
      if (!connected || localStop) {
        closeMeetingAfterClip = false;
        break;
      }
      const list = closeMeetingAfterClip && !meetingOn && Array.isArray(linesToSummarize)
        ? linesToSummarize
        : meetingLines;
      freezeMeetingDraft(heard, list);
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
        continue;
      }
      showMeetingStatus();
      continue;
    }
    setStatus(listenStatus());
    setCapsuleState("listening");
    const clip = await recordUntilSilence(micStream);
    if (!connected || localStop) {
      clearThinkCue();
      closeMeetingAfterClip = false;
      break;
    }
    if (paused) {
      clearThinkCue();
      continue;
    }
    if (!clip || clip.size < 2000) {
      clearThinkCue();
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
      }
      continue;
    }

    setStatus(meetingOn ? `Writing down the ${captureKind === "lecture" ? "lecture" : "meeting"}…` : "Writing down what you said…");
    setCapsuleState("thinking");
    let text = "";
    try {
      text = await transcribeClip(clip);
    } catch (err) {
      console.error("Failed while transcribing locally:", err);
      clearThinkCue();
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
        continue;
      }
      setStatus(err.message || "The local voice model could not hear that.");
      await sleep(600);
      continue;
    }
    if (closeMeetingAfterClip && !meetingOn) {
      closeMeetingAfterClip = false;
      const line = String(text || "").trim();
      if (line && !looksLikeSilence(line) && Array.isArray(linesToSummarize) && linesToSummarize.at(-1) !== line) {
        linesToSummarize.push(line);
        const bubble = addBubble(captureRole(), line, false);
        bubble.querySelector(".who").textContent = captureName();
      }
      await speakMeetingSummary();
      continue;
    }
    if (meetingOn) {
      clearThinkCue();
      addMeetingLine(text);
      showMeetingStatus();
      continue;
    }
    if (looksLikeSilence(text)) {
      clearThinkCue();
      setStatus(listenStatus());
      setCapsuleState("listening");
      continue;
    }
    // Two whispers: show both lines before anything else happens to the words.
    if (earsSelect.value === "whisper-both") {
      const heard = addBubble("note", text, false);
      heard.querySelector(".who").textContent = "Heard";
    }
    if (medicalListening()) {
      const cleaned = await medicalTurn({ text, at: performance.now() });
      if (!cleaned || !connected || localStop) continue;
      if (cleaned.english && cleaned.english !== cleaned.question) showMedicalNote(cleaned.english);
      if (!cleaned.question) continue;
      addBubble("user", cleaned.question, false);
      await answerWithBrain(cleaned.question);
      continue;
    }
    let question = questionFromHeard(text);
    if (keyboardWake) {
      // The key already said this sentence is for the brain. Hey is optional.
      if (!question) {
        const fromKey = wordsFromKey(text);
        if (fromKey) question = fromKey;
      }
      if (question) keyboardWake = false;
      else {
        clearThinkCue();
        setStatus(KEY_WAKE_STATUS);
        setCapsuleState("listening");
        continue;
      }
    } else if (!question && jevListening()) {
      question = await jevQuestion({ text, at: performance.now() });
    }
    // No wake phrase, or only the phrase with no question: stay quiet.
    if (!question) {
      clearThinkCue();
      setStatus(listenStatus());
      setCapsuleState("listening");
      continue;
    }
    addBubble("user", question, false);
    await answerWithBrain(question);
  }
  localEars = false;
}

/**
 * Voice control reads answers aloud. One session is opened when the call
 * starts and reused for every answer, so each answer skips the connection
 * setup. The microphone is not attached, so listening is not billed.
 */
let voiceBlocked = "";

function ensureSpeaker() {
  if (voiceBlocked) return Promise.reject(new Error(voiceBlocked));
  if (!speaker || speaker.closed) speaker = openSpeaker();
  return speaker.ready;
}

function openSpeaker() {
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const s = { peer, channel, ctx, analyser, remoteStream: null, closed: false, listener: null };

  peer.ontrack = (event) => {
    s.remoteStream = event.streams[0];
    remoteAudio.srcObject = s.remoteStream;
    remoteAudio.play().catch(() => {});
    try {
      ctx.createMediaStreamSource(s.remoteStream).connect(analyser);
    } catch (err) {
      console.error("Failed while watching the spoken audio:", err);
    }
  };
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") closeSpeaker(s, "Voice control lost the connection.");
  });
  channel.addEventListener("message", (event) => {
    const msg = safeParse(event.data);
    if (msg) s.listener?.(msg);
  });

  s.ready = (async () => {
    peer.addTransceiver("audio", { direction: "recvonly" });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer, 1500);
    const sdpResponse = await fetch(
      `/session?voice=${encodeURIComponent(voiceSelect.value)}&model=gpt-realtime-2.1-mini&speak=1`,
      {
        method: "POST",
        body: peer.localDescription?.sdp || offer.sdp,
        headers: { "Content-Type": "application/sdp" },
      }
    );
    const answerBody = await sdpResponse.text();
    if (!sdpResponse.ok) {
      let message = answerBody;
      try {
        const parsed = JSON.parse(answerBody);
        message = parsed.details?.error?.message || parsed.error || answerBody;
      } catch {
        /* keep the raw text */
      }
      if (/credit|quota|billing/i.test(message)) {
        voiceBlocked = "OpenAI has no credits left, so the voice cannot speak. The written answer still shows. Add credits, then start again.";
        throw new Error(voiceBlocked);
      }
      throw new Error(message || "Voice control could not speak.");
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answerBody });
    if (channel.readyState !== "open") {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Voice control did not connect.")), 10000);
        channel.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    await ctx.resume().catch(() => {});
    return s;
  })();
  s.ready.catch((err) => {
    console.error("Failed while opening voice control:", err);
    closeSpeaker(s);
  });
  return s;
}

function closeSpeaker(s = speaker, reason = "") {
  if (!s || s.closed) return;
  s.closed = true;
  s.listener?.({ type: "speaker.closed", reason });
  try { s.channel.close(); } catch { /* already closed */ }
  try { s.peer.close(); } catch { /* already closed */ }
  s.ctx.close().catch(() => {});
  if (speaker === s) speaker = null;
}

/**
 * Speak an answer while it is still being written.
 * push() queues a piece of text; each piece is read as soon as the
 * previous one has been sent. end() says no more text is coming.
 * done resolves once the last words have finished playing.
 */
function speakStream(s) {
  // Stop pauses the player. The voice line stays open, so play it again for this answer.
  if (s.remoteStream) {
    remoteAudio.srcObject = s.remoteStream;
    remoteAudio.play().catch(() => {});
  }
  const queue = [];
  const samples = new Uint8Array(s.analyser.fftSize);
  let active = false;
  let ended = false;
  let pauseTimer = null;
  let settled = false;
  let heardSpeech = false;
  let quietSince = 0;
  let totalChars = 0;
  let cap = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const idle = () => ended && !active && !queue.length;

  const finish = (err) => {
    if (settled) return;
    settled = true;
    clearInterval(watch);
    clearTimeout(cap);
    if (s.listener === onMessage) s.listener = null;
    if (err) rejectDone(err);
    else resolveDone();
  };

  const pump = () => {
    if (active || !queue.length || s.closed) return;
    const next = queue.shift();
    // A pause is silence before the next words, not something to read aloud.
    if (next && typeof next === "object" && next.pause) {
      active = true;
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        active = false;
        pump();
      }, next.pause);
      return;
    }
    active = true;
    s.channel.send(JSON.stringify({
      type: "response.create",
      response: {
        // Out of band, with no history: each piece costs only its own tokens.
        conversation: "none",
        input: [],
        output_modalities: ["audio"],
        max_output_tokens: 4096,
        instructions: `Read this text aloud exactly, from the first word to the last. Do not summarize. Do not add anything.\n\n${next}`,
      },
    }));
  };

  const onMessage = (msg) => {
    if (msg.type === "response.done") {
      addResponseUsage(msg.response);
      active = false;
      quietSince = 0;
      pump();
    } else if (msg.type === "output_audio_buffer.stopped" && idle() && heardSpeech) {
      setTimeout(() => finish(), 300);
    } else if (msg.type === "error") {
      closeSpeaker(s);
      finish(new Error(msg.error?.message || "Voice control could not speak."));
    } else if (msg.type === "speaker.closed") {
      finish(msg.reason ? new Error(msg.reason) : undefined);
    }
  };
  s.listener = onMessage;

  // Close only after the spoken audio has gone quiet.
  // response.done arrives before the last words finish playing.
  const watch = setInterval(() => {
    const track = s.remoteStream?.getAudioTracks()[0];
    if (idle() && track?.readyState === "ended") {
      finish();
      return;
    }
    s.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    if (Math.sqrt(sum / samples.length) > 0.012) {
      if (!heardSpeech) {
        markAnswerStarted();
        setStatus("Speaking with voice control…");
        setCapsuleState("speaking");
      }
      heardSpeech = true;
      quietSince = 0;
      return;
    }
    if (!idle() || !heardSpeech) return;
    if (!quietSince) quietSince = performance.now();
    if (performance.now() - quietSince > 700) finish();
  }, 100);

  return {
    done,
    push(text) {
      if (settled || !text) return;
      totalChars += text.length;
      queue.push(text);
      pump();
    },
    pause(ms) {
      if (settled) return;
      queue.push({ pause: ms });
      pump();
    },
    end() {
      ended = true;
      // A long answer needs time to be spoken. About 12 characters a second, plus a cushion.
      cap = setTimeout(() => finish(), Math.min(180000, 8000 + totalChars * 90));
      if (!totalChars) finish();
    },
    stop() {
      queue.length = 0;
      ended = true;
      clearTimeout(pauseTimer);
      if (active && !s.closed) {
        s.channel.send(JSON.stringify({ type: "response.cancel" }));
        s.channel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      }
      finish();
    },
  };
}

/**
 * Kokoro: the same local voice the claude-voice app uses, served by this app.
 * Each piece is sent for speech as soon as it arrives, so the next sentence is
 * ready while the current one plays. A piece Kokoro cannot speak uses the Mac voice.
 */
let kokoroSpeech = null;

const ARABIC = /[\u0600-\u06FF]/;

function kokoroVoice() {
  let chain = Promise.resolve();
  let stopped = false;
  let playing = null;
  let release = null;
  let pauseTimer = null;
  let releasePause = null;
  return (kokoroSpeech = {
    get done() { return chain; },
    // markWait is false for a cue that should not reset the wait clock.
    push(text, markWait = true) {
      // Kokoro reads English only. Arabic goes to the Mac's Arabic voice.
      const arabic = ARABIC.test(text);
      const clip = arabic ? Promise.reject(new Error("Kokoro reads English only")) : fetch("/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).then((response) => {
        if (!response.ok) throw new Error(`Kokoro returned ${response.status}`);
        return response.blob();
      });
      clip.catch(() => {});
      chain = chain.then(async () => {
        if (stopped) return;
        try {
          const url = URL.createObjectURL(await clip);
          if (stopped) return;
          playing = new Audio(url);
          playing.onplaying = () => {
            if (!markWait) return;
            markAnswerStarted();
            setStatus("Speaking with the Kokoro voice.");
            setCapsuleState("speaking");
          };
          await new Promise((resolve) => {
            release = resolve;
            playing.onended = resolve;
            playing.onerror = resolve;
            playing.play().catch(resolve);
          });
          release = null;
          URL.revokeObjectURL(url);
        } catch (err) {
          if (!arabic) console.error("Failed while speaking with Kokoro, using the Mac voice:", err);
          if (stopped) return;
          const utterance = new SpeechSynthesisUtterance(text);
          if (arabic) utterance.lang = "ar-SA";
          utterance.onstart = () => {
            if (!markWait) return;
            markAnswerStarted();
            setCapsuleState("speaking");
          };
          await new Promise((resolve) => {
            release = resolve;
            utterance.onend = resolve;
            utterance.onerror = resolve;
            speechSynthesis.speak(utterance);
          });
          release = null;
        }
      });
    },
    // Silence in the queue, so the next word waits and the answer stays behind it.
    pause(ms) {
      chain = chain.then(() => new Promise((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        releasePause = resolve;
        pauseTimer = setTimeout(() => {
          releasePause = null;
          resolve();
        }, ms);
      }));
    },
    end() {},
    stop() {
      stopped = true;
      clearTimeout(pauseTimer);
      releasePause?.();
      releasePause = null;
      playing?.pause();
      speechSynthesis.cancel();
      release?.();
      release = null;
    },
  });
}

/**
 * Free fallback voice: the Mac's built-in speech, in this window.
 * Same shape as speakStream, so answerWithBrain can use either.
 */
function macVoice(status) {
  setStatus(status);
  setCapsuleState("speaking");
  let last = Promise.resolve();
  let pauseTimer = null;
  return {
    get done() { return last; },
    push(text, markWait = true) {
      last = last.then(() => new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        if (ARABIC.test(text)) utterance.lang = "ar-SA";
        utterance.onstart = () => {
          if (!markWait) return;
          markAnswerStarted();
        };
        utterance.onend = resolve;
        utterance.onerror = resolve;
        speechSynthesis.speak(utterance);
      }));
    },
    pause(ms) {
      last = last.then(() => new Promise((resolve) => {
        pauseTimer = setTimeout(resolve, ms);
      }));
    },
    end() {},
    stop() {
      clearTimeout(pauseTimer);
      speechSynthesis.cancel();
    },
  };
}

/**
 * Last cleanup before a piece is spoken, in case the model still wrote
 * markdown, abbreviations, or a clock code. The bubble keeps the original text.
 * The voice reads these words literally, so this step writes what should be heard.
 */
function speechNumber(n) {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  if (n < 20) return small[n];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty"];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return one ? `${tens[ten]}-${small[one]}` : tens[ten];
}

function speechClock(hour24, minute) {
  let part = "in the morning";
  if (hour24 >= 12 && hour24 < 17) part = "in the afternoon";
  else if (hour24 >= 17 && hour24 < 22) part = "in the evening";
  else if (hour24 >= 22 || hour24 < 5) part = "at night";
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  if (minute === 0) return `${speechNumber(hour)} o'clock ${part}`;
  if (minute < 10) return `${speechNumber(hour)} oh ${speechNumber(minute)} ${part}`;
  return `${speechNumber(hour)} ${speechNumber(minute)} ${part}`;
}

function forSpeech(text) {
  const months = {
    jan: "January", feb: "February", mar: "March", apr: "April",
    jun: "June", jul: "July", aug: "August", sep: "September", sept: "September",
    oct: "October", nov: "November", dec: "December",
  };
  return text
    .replace(/<[^>]+>/g, " ")                       // HTML tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")      // [label](link) -> label
    .replace(/https?:\/\/\S+/g, "")                 // bare web addresses
    .replace(/^\s*#{1,6}\s*/gm, "")                 // headings
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")     // list markers
    .replace(/^\s*(?:note|source|sources|file)s?\s*:.*$/gim, "") // trailing source lines
    .replace(/[*_`~|>#\[\]]+/g, "")                     // bold, italics, code, tables, quotes, brackets
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?\b/gi, (_all, h, m, ap) => {
      let hour = Number(h);
      const minute = Number(m);
      if (ap) {
        const evening = /^p/i.test(ap);
        if (evening && hour < 12) hour += 12;
        if (!evening && hour === 12) hour = 0;
      }
      return speechClock(hour, minute);
    })
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?/gi, (match) => {
      return months[match.toLowerCase().replace(/\.$/, "")] || match;
    })
    .replace(/([^\s.!?:,;])[ \t]*\n+/g, "$1. ")       // a line break is a pause
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where to cut the answer so voice control can start reading early.
 * The first piece is one short sentence; later pieces are longer so the
 * voice keeps a natural flow. Returns -1 when no cut is ready yet.
 */
function sentenceCut(text, minLen) {
  const boundary = /[.!?](?=\s)|\n/g;
  let match;
  while ((match = boundary.exec(text))) {
    if (match.index + 1 >= minLen) return match.index + 1;
  }
  return -1;
}

function clearChatMemory() {
  // The next call starts fresh. The words already on screen stay so you can still read them.
  chatTurns = [];
  chatMemory = "";
  compressAbort?.abort();
  compressGen += 1;
}

async function releaseAllLocalModels() {
  setStatus("Stopping local models…");
  try {
    const response = await fetch("/stop-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not stop the local models.");
    const count = Array.isArray(data.stopped) ? data.stopped.length : 0;
    setStatus(count
      ? "Call ended. Local models were stopped. This conversation is saved for next time."
      : "Call ended. This conversation is saved for next time.");
  } catch (err) {
    console.error("Failed while stopping local models:", err);
    setStatus("Call ended. This conversation is saved, but a local model may still be in memory.");
  }
}
async function hangUp({ keepStatus = false } = {}) {
  // Stop the answer first, so Ollama is free to unload the model.
  keyboardWake = false;
  listenEpoch += 1;
  cancelAnswer = true;
  askAbort?.abort();
  compressAbort?.abort();
  compressGen += 1;
  stopSpeaking();
  connected = false;
  localStop = true;
  closeLectureForm(null);
  voiceBlocked = "";
  muted = false;
  try { dc?.close(); } catch { /* already closed */ }
  dc = null;
  try {
    pc?.getSenders().forEach((sender) => sender.track?.stop());
    pc?.close();
  } catch { /* already closed */ }
  pc = null;
  closeSpeaker();
  stopEars();
  stopGeminiCall();
  kokoroSpeech?.stop();
  speechSynthesis.cancel();
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  remoteAudio.srcObject = null;
  assistantPartialEl = null;
  userPartialEl = null;
  talkBtn.setAttribute("aria-pressed", "false");
  talkLabel.textContent = "Start talking";
  voiceSelect.disabled = false;
  modelSelect.disabled = false;
  reasoningSelect.disabled = false;
  paused = false;
  finishMeetingLine();
  const pending = [
    ...(Array.isArray(linesToSummarize) ? linesToSummarize : []),
    ...meetingLines,
  ];
  if (pending.length) {
    const extra = pending.join("\n");
    if (!savedMeeting.includes(extra)) {
      savedMeeting = savedMeeting ? `${savedMeeting}\n${extra}` : extra;
    }
    if (meetingOn) {
      if (captureKind === "lecture") savedNotesKind = "lecture";
      const name = captureName();
      const bubble = addBubble(captureRole(), `${name} kept. Ask me about it the next time you start talking.`, false);
      bubble.querySelector(".who").textContent = name;
    }
  }
  meetingOn = false;
  captureKind = "";
  lectureFormOpen = false;
  meetingLines = [];
  closeMeetingAfterClip = false;
  linesToSummarize = null;
  localEars = false;
  recordingClip = false;
  paintMeetingButton();
  muteBtn.disabled = true;
  muteBtn.textContent = "Mute mic";
  muteBtn.classList.remove("is-muted");
  syncCallButtons();
  setCapsuleState("idle");
  setBusy(false);
  if (!keepStatus) setStatus("Call ended");
}

function handleServerEvent(event) {
  if (!event || typeof event !== "object") return;
  const type = event.type;

  if (type === "input_audio_buffer.speech_started") {
    if (lectureFormOpen) {
      stopSpeaking();
      setStatus("Type the presenter's name and edit the title, then press Write summary.");
      return;
    }
    if (meetingOn) {
      showMeetingStatus();
      return;
    }
    clearThinkCue();
    setCapsuleState("listening");
    setStatus("Listening…");
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      assistantPartialEl = null;
    }
    return;
  }
  if (type === "output_audio_buffer.started") {
    markAnswerStarted();
    return;
  }
  if (type === "input_audio_buffer.speech_stopped") {
    if (lectureFormOpen) {
      stopSpeaking();
      return;
    }
    if (meetingOn) {
      showMeetingStatus();
      return;
    }
    questionEndedAt = performance.now();
    // Models that do not hear for themselves beep while the answer is prepared.
    if (needsVoiceControl(selectedModel())) armThinkCue(questionEndedAt);
    setStatus("Thinking…");
    setCapsuleState("thinking");
    return;
  }
  if (type === "response.created" || type === "response.output_item.added") {
    if (lectureFormOpen) {
      stopSpeaking();
      return;
    }
    if (meetingOn) {
      stopSpeaking();
      showMeetingStatus();
      return;
    }
    setCapsuleState("speaking");
    setStatus("Speaking…");
    return;
  }
  if (type === "response.done" || type === "response.output_audio.done" || type === "output_audio_buffer.stopped") {
    if (type === "response.done") {
      addResponseUsage(event.response);
      scriptedReply = false;
    }
    if (connected && !muted) {
      if (meetingOn) showMeetingStatus();
      else {
        setCapsuleState("listening");
        setStatus("Listening… speak anytime");
      }
    }
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      assistantPartialEl = null;
    }
    return;
  }
  if (type === "error") {
    setStatus(event.error?.message || event.message || "Voice model error");
    return;
  }

  if (
    type === "response.function_call_arguments.done" ||
    (type === "response.output_item.done" && event.item?.type === "function_call")
  ) {
    answerToolCall(event);
    return;
  }

  if (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "conversation.item.input_audio_transcription.done"
  ) {
    const text = event.transcript || event.item?.content?.[0]?.transcript || "";
    if (lectureFormOpen) return;
    if (meetingOn) {
      freezeMeetingDraft(text, meetingLines);
      showMeetingStatus();
      return;
    }
    let question = questionAfterWake(text.trim());
    // null means they did not say Hey. "" means they said only Hey.
    if (question === null && keyboardWake) {
      const fromKey = wordsFromKey(text);
      if (fromKey) question = fromKey;
    }
    if (question === null) {
      clearThinkCue();
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      setStatus(listenStatus());
      return;
    }
    keyboardWake = false;
    stopSpeaking();
    if (!question) {
      setStatus("Go ahead. A short pause is fine.");
      setCapsuleState("listening");
      return;
    }
    finalizeUser(question);
    if (selectedModel()?.hears) {
      lastQuestion = question;
      playTinyMove(question);
      sendEvent({ type: "response.create" });
    }
    else if (needsVoiceControl(selectedModel())) answerWithBrain(question);
    return;
  }
  if (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "conversation.item.input_audio_transcription.partial"
  ) {
    const text = event.delta || event.transcript || "";
    if (lectureFormOpen) return;
    if (meetingOn) {
      if (text) addMeetingPiece(text);
      return;
    }
    if (text) updateUserPartial(text);
    return;
  }
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    if (lectureFormOpen || meetingOn) return;
    if (!scriptedReply && event.delta) appendAssistantPartial(event.delta);
    return;
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    if (scriptedReply) return;
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      if (event.transcript) assistantPartialEl.querySelector(".text").textContent = event.transcript;
      logDay(lastQuestion, assistantPartialEl.querySelector(".text").textContent);
      assistantPartialEl = null;
    } else if (event.transcript) {
      addBubble("assistant", event.transcript, false);
      logDay(lastQuestion, event.transcript);
    }
  }
}

/** Run a tool the voice model asked for, then hand the result back. */
async function answerToolCall(event) {
  if (meetingOn || lectureFormOpen) return;
  const item = event.item || event;
  const callId = item.call_id || event.call_id;
  const name = item.name || event.name;
  if ((name !== "search_notes" && name !== "here_and_now") || !callId || handledCalls.has(callId)) return;
  handledCalls.add(callId);

  let output = "The tool failed.";
  try {
    if (name === "here_and_now") {
      setStatus("Checking the time…");
      setCapsuleState("thinking");
      const response = await fetch("/here");
      const data = await response.json();
      output = data.text || output;
    } else {
      let query = "";
      try {
        query = JSON.parse(item.arguments || event.arguments || "{}").query || "";
      } catch (err) {
        console.error("Failed while reading the note search:", err);
      }
      setStatus("Looking through your notes…");
      setCapsuleState("thinking");
      const response = await fetch(`/notes?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      output = data.notes || "No matching notes.";
    }
  } catch (err) {
    console.error(`Failed while running the ${name} tool:`, err);
    output = "The tool failed.";
  }

  sendEvent({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  });
  sendEvent({ type: "response.create" });
}

/**
 * A reply can have two parts. The voice reads the words before the marker.
 * EMAIL_BODY is the letter that Outlook opens.
 * SKILL_BODY is a document, such as a product plan, that stays on the screen.
 * While the answer is still arriving, hold back a half-written marker
 * so the voice does not say it.
 */
function splitEmailDraft(raw, finished) {
  const emailAt = raw.search(/EMAIL_BODY/i);
  const skillAt = raw.search(/SKILL_BODY/i);
  let token = "";
  let at = -1;
  if (emailAt >= 0 && (skillAt < 0 || emailAt <= skillAt)) {
    token = "EMAIL_BODY";
    at = emailAt;
  } else if (skillAt >= 0) {
    token = "SKILL_BODY";
    at = skillAt;
  }
  if (at >= 0) {
    const spoken = raw.slice(0, at);
    const written = raw.slice(at + token.length).replace(/^[\s:—-]+/, "");
    return {
      spoken: finished ? spoken.trim() : spoken,
      written: finished ? written.trim() : written,
      closed: true,
      kind: token === "SKILL_BODY" ? "skill" : "email",
    };
  }
  if (!finished) {
    const upper = raw.toUpperCase();
    for (const name of ["EMAIL_BODY", "SKILL_BODY"]) {
      for (let size = name.length - 1; size > 3; size -= 1) {
        if (upper.endsWith(name.slice(0, size))) {
          return { spoken: raw.slice(0, -size), written: "", closed: false, kind: "" };
        }
      }
    }
  }
  return { spoken: finished ? raw.trim() : raw, written: "", closed: false, kind: "" };
}

/** Put a skill's written document under the short spoken line. */
function showSkillDoc(bubble, text) {
  const clean = String(text || "").trim();
  if (!bubble || !clean) return;
  let doc = bubble.querySelector(".skill-doc");
  if (!doc) {
    doc = document.createElement("pre");
    doc.className = "skill-doc";
    bubble.append(doc);
  }
  doc.textContent = clean;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/** "Haitham Aryan" becomes "Haitham". */
function firstName(full) {
  const word = String(full || "").trim().split(/\s+/)[0].replace(/[,.]+$/, "");
  if (!/^[A-Za-z][A-Za-z'’-]+$/.test(word)) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Fix the letter before it is shown.
 * The other person's first name replaces [Sender Name]. IS replaces [Your Name].
 */
/**
 * Turn a flat draft into a short letter, with a comma, a period, and a blank line
 * between the greeting, the message, and the sign-off.
 */
function polishReply(body, fullName) {
  const first = firstName(fullName);
  let text = String(body || "")
    .replace(/[ \t]*Get Outlook for (?:Mac|iOS|Android|Windows)[^\n]*/gi, "")
    .replace(/\[(?:Sender|Recipient)\s*Name\]/gi, first || "colleague")
    .replace(/\[Your Name\]/gi, "IS");
  if (first) text = text.replace(/^(\s*Dear\s+)(?:colleague|friend|there)\b/i, `$1${first}`);
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

  const sentenceStart = new Set([
    "i", "we", "the", "please", "this", "it", "thank", "thanks", "can", "could",
    "would", "let", "just", "also", "there", "here", "my", "our", "your", "as",
    "if", "when", "after", "before", "a", "an", "so", "and", "but",
  ]);

  let sign = "";
  const signMatch = text.match(/^([\s\S]*?)\s*\bbest regards\b[,.]?\s*(?:\n+\s*)?(?:IS)?\s*$/i);
  if (signMatch) {
    text = signMatch[1].trim();
    sign = "Best regards,\n\nIS";
  }

  let greet = "";
  const dear = text.match(/^dear\s+([\s\S]+)$/i);
  if (dear) {
    const rest = dear[1].trim();
    const withComma = rest.match(/^([^,\n]{1,80}),\s*([\s\S]*)$/);
    const withLine = rest.match(/^([^\n]{1,80})\n+([\s\S]*)$/);
    if (withComma) {
      greet = `Dear ${withComma[1].trim()},`;
      text = withComma[2].trim();
    } else if (withLine && withLine[1].trim().split(/\s+/).length <= 4) {
      greet = `Dear ${withLine[1].replace(/[,.]$/, "").trim()},`;
      text = withLine[2].trim();
    } else {
      const words = rest.split(/\s+/);
      const name = [];
      for (const word of words) {
        const bare = word.replace(/[,.]$/, "");
        if (name.length && sentenceStart.has(bare.toLowerCase())) break;
        if (name.length >= 3) break;
        if (name.length && !/^[A-Z]/.test(bare)) break;
        name.push(bare);
        if (/[,.]$/.test(word)) break;
      }
      greet = `Dear ${name.join(" ")},`;
      text = words.slice(name.length).join(" ").replace(/^[,.\s]+/, "");
    }
  }

  const message = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .map((line, index) => (index === 0 ? line.charAt(0).toUpperCase() + line.slice(1) : line))
    .join("\n\n");

  return [greet, message, sign].filter(Boolean).join("\n\n");
}

/** Ask this Mac to open the written reply in Outlook. The message is not sent. */
async function openInOutlook(button, outlook, body) {
  button.disabled = true;
  setStatus("Opening Outlook…");
  try {
    const response = await fetch("/open-outlook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: outlook.to || "",
        name: outlook.name || "",
        subject: outlook.subject || "",
        body,
        original: outlook.original || "",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Outlook did not open.");
    const kind = outlook.original || /^re:/i.test(outlook.subject || "") ? "reply" : "email";
    setStatus(outlook.to
      ? `Outlook has the ${kind}. Press Send when it looks right.`
      : `Outlook has the ${kind}. Type who it goes to, then press Send.`);
  } catch (err) {
    console.error("Failed while opening Outlook:", err);
    setStatus(err.message || "Outlook did not open.");
    button.disabled = false;
  }
}

/** The new letter, then a line, then the email being answered. */
function replyWithOriginal(body, original) {
  const quote = String(original || "").trim();
  if (!quote) return body;
  const start = quote.slice(0, 80);
  if (start && body.includes(start)) return body;
  return `${body}\n\n________________________________\n\n${quote}`;
}

function attachOutlookButton(bubble, outlook, body) {
  const letter = polishReply(body, outlook?.name);
  const shown = replyWithOriginal(letter, outlook?.original);
  if (!bubble || !letter || bubble.querySelector(".outlook-btn")) return;
  if (shown !== bubble.querySelector(".text")?.textContent?.trim()) {
    const draft = document.createElement("p");
    draft.className = "email-draft";
    draft.textContent = shown;
    bubble.append(draft);
  }
  body = letter;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn small outlook-btn";
  button.textContent = "Open in Outlook";
  button.addEventListener("click", () => openInOutlook(button, outlook, body));
  bubble.append(button);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// One shared tone generator, so each beep does not open a new one.
let beepCtx = null;

/** A short tone, a bit louder than a whisper. Played while the model works. */
function playBeep() {
  if (!beepCtx || beepCtx.state === "closed") beepCtx = new AudioContext();
  if (beepCtx.state === "suspended") beepCtx.resume();
  const osc = beepCtx.createOscillator();
  const gain = beepCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  const now = beepCtx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(gain);
  gain.connect(beepCtx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}

// Stop can cancel the beeps if the user moves on.
let clearThinkCue = () => {};
let thinkCueOn = false;
// The first tone is half a second after they stop. Later tones stay two seconds apart.
const FIRST_BEEP_MS = 500;
const BEEP_EVERY_MS = 2000;

/** How long to wait so the next beep stays on that half-second, then two-second, rhythm. */
function beepDelay(endedAt) {
  const mark = endedAt || performance.now();
  const elapsed = Math.max(0, performance.now() - mark);
  if (elapsed <= FIRST_BEEP_MS) return FIRST_BEEP_MS - elapsed;
  const sinceFirst = elapsed - FIRST_BEEP_MS;
  const intoGap = sinceFirst % BEEP_EVERY_MS;
  return intoGap === 0 ? 0 : BEEP_EVERY_MS - intoGap;
}

/**
 * The beep after you stop talking is turned off.
 * This still exists so the rest of the page can call it without playing a tone.
 */
function armThinkCue() {}

/** Bonsai and GPT-6 write the answer. Voice control is what speaks it. */
async function answerWithBrain(question, extras) {
  const writingMinutes = Boolean(extras?.summarizeMeeting);
  const writingLecture = Boolean(extras?.summarizeLecture);
  const writingNotes = writingMinutes || writingLecture;
  await deskReady;
  if (meetingOn || lectureFormOpen || brainBusy || paused) return;
  const tinyMove = writingNotes ? "" : playTinyMove(question);
  if (!connected) setBusy(true);
  compressAbort?.abort();
  compressGen += 1;
  lastQuestion = question;
  brainBusy = true;
  syncCallButtons();
  cancelAnswer = false;
  currentAnswerBubble = null;
  askAbort = new AbortController();
  if (micStream && !muted) watchWhileAnswering(micStream);
  setStatus(`Thinking with ${selectedModel()?.label || "the selected model"}…`);
  setCapsuleState("thinking");
  // Local models (Bonsai) always use the Kokoro voice on this Mac: free, no OpenAI.
  const macOnly = Boolean(selectedModel()?.local);
  const speakerReady = macOnly ? null : ensureSpeaker();
  speakerReady?.catch(() => {});
  let speech = null;
  // Keep the beeps that started when they stopped talking. A typed question starts them now.
  armThinkCue();
  let bubble = null;
  let reader = null;
  let answer = "";
  let rawAnswer = "";
  let spokenShown = "";
  let outlook = null;
  let keepMemory = true;
  let remembered = false;
  try {
    const response = await fetch("/ask", {
      method: "POST",
      signal: askAbort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        history: chatTurns,
        memory: chatMemory,
        meetingNotes: savedMeeting,
        notesKind: savedNotesKind,
        summarizeMeeting: Boolean(extras?.summarizeMeeting),
        summarizeLecture: writingLecture,
        presenter: extras?.presenter || "",
        title: extras?.title || "",
        photo: writingNotes ? "" : photoForQuestion(question),
        tinyMove,
        skill: activeSkillId,
        model: modelSelect.value,
        reasoning: reasoningSelect.value,
        spoken: true,
      }),
    });
    if (!response.ok || !response.body) {
      let message = "The selected model could not answer.";
      try {
        const data = await response.json();
        if (data.error) message = data.error;
      } catch {
        /* keep the plain message */
      }
      throw new Error(message);
    }

    reader = response.body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    let unspoken = "";
    let heardCue = false;
    const speakReady = async (force) => {
      while (unspoken.trim()) {
        const cut = force ? unspoken.length : sentenceCut(unspoken, speech ? 200 : 40);
        if (cut < 0) return;
        const piece = forSpeech(unspoken.slice(0, cut));
        unspoken = unspoken.slice(cut);
        if (!speech && !voiceBlocked && !macOnly) {
          try {
            speech = speakStream(await speakerReady);
            setStatus("Voice control is reading the answer…");
            setCapsuleState("speaking");
          } catch (err) {
            if (!voiceBlocked) throw err;
          }
        }
        // Voice control could not connect. The Mac voice is only a stand-in.
        speech ??= macOnly ? kokoroVoice() : macVoice("Speaking with the Mac voice. OpenAI has no credits.");
        activeSpeech = speech;
        if (!heardCue) {
          heardCue = true;
          clearThinkCue();
        }
        if (paused || cancelAnswer) {
          speech.stop();
          return;
        }
        if (piece) speech.push(piece);
      }
    };
    while (true) {
      if (cancelAnswer) break;
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
          console.error("Failed while reading the answer:", err);
          continue;
        }
        if (event.type === "status") {
          setStatus(event.message || "Looking on the web…");
          setCapsuleState("thinking");
          if (/look|search/i.test(event.message || "Looking")) setActivity("searching");
        } else if (event.type === "work" && event.card) {
          showFlash(event.card);
        } else if (event.type === "sources") {
          if (event.sources?.length) setActivity("searching");
        } else if (event.type === "outlook") {
          setActivity("writing");
          outlook = {
            to: event.to || "",
            subject: event.subject || "",
            name: event.name || "",
            original: event.original || "",
          };
        } else if (event.type === "skill") {
          // The server grabbed a skill, or put one away. Highlight the list.
          setActiveSkill(event.id || "");
          skillLabel = event.name || "";
        } else if (event.type === "delta") {
          rawAnswer += event.text || "";
          const parts = splitEmailDraft(rawAnswer, false);
          const fresh = parts.spoken.startsWith(spokenShown)
            ? parts.spoken.slice(spokenShown.length)
            : parts.spoken;
          spokenShown = parts.spoken;
          unspoken += fresh;
          bubble ??= addBubble("assistant", "", true);
          currentAnswerBubble = bubble;
          if (writingNotes) {
            bubble.classList.add(writingLecture ? "lecture-notes" : "minutes");
            bubble.querySelector(".who").textContent = writingLecture ? "Talk" : "Minutes";
          }
          if (parts.kind === "skill" && skillLabel) {
            bubble.querySelector(".who").textContent = skillLabel;
          }
          bubble.querySelector(".text").textContent = spokenShown.trim();
          if (parts.kind === "skill" && parts.written) showSkillDoc(bubble, parts.written);
          transcriptEl.scrollTop = transcriptEl.scrollHeight;
        } else if (event.type === "usage") addBrainUsage(event);
        else if (event.type === "ignored") {
          keepMemory = false;
          return;
        }
        else if (event.type === "error") throw new Error(event.message || "The selected model failed.");
      }
      await speakReady(false);
    }

    if (cancelAnswer) return;
    const finalParts = splitEmailDraft(rawAnswer, true);
    const spoken = finalParts.spoken.trim();
    const written = finalParts.written.trim();
    const leftover = spoken.startsWith(spokenShown.trim())
      ? spoken.slice(spokenShown.trim().length)
      : spoken.slice(spokenShown.length);
    if (leftover.trim()) unspoken += leftover;
    answer = written ? `${spoken}\n\n${written}` : spoken;
    if (!answer.trim()) throw new Error("The selected model returned an empty answer.");
    if (bubble) {
      bubble.classList.remove("partial");
      if (finalParts.kind === "skill") {
        bubble.querySelector(".text").textContent = spoken || "The plan is on the screen.";
        if (skillLabel) bubble.querySelector(".who").textContent = skillLabel;
        showSkillDoc(bubble, written);
      } else {
        bubble.querySelector(".text").textContent = spoken || written;
      }
      if (writingNotes) {
        bubble.classList.add(writingLecture ? "lecture-notes" : "minutes");
        bubble.querySelector(".who").textContent = writingLecture ? "Talk" : "Minutes";
        // The saved file uses these words, and the buttons move under them.
        if (meetingToSave) meetingToSave.minutes = spoken;
        if (meetingSaveRow) bubble.append(meetingSaveRow);
      }
    }
    if (outlook) {
      attachOutlookButton(bubble, outlook, written || spoken);
      saveEmailDraft(outlook, written || spoken);
    }
    rememberTurn(question, answer);
    remembered = true;
    compressWhileSpeaking();
    await speakReady(true);
    speech?.end();
    await speech?.done;
    // The server confirms a saved memo or an opened meeting with these words.
    if (/^I (?:saved that memo|opened that meeting)/.test(spoken)) flashSaved();
    if (connected && !localStop) {
      setCapsuleState("listening");
      setStatus(writingLecture
        ? "The talk summary is written. Say Hey, then ask anything about the lecture."
        : writingMinutes
        ? "The minutes are written. Say Hey, then ask anything about the meeting."
        : macOnly
        ? WAKE_STATUS
        : voiceBlocked
        ? "Listening. Say Hey, then your question. Voice control has no credits, so the Mac voice spoke."
        : WAKE_STATUS);
    } else if (!connected && !localStop) {
      setCapsuleState("idle");
      setStatus("Type another question, or press Start talking.");
    }
  } catch (err) {
    speech?.stop();
    if (err?.name === "AbortError") return;
    console.error("Failed while asking the selected model:", err);
    bubble?.classList.remove("partial");
    setStatus(err.message || "The selected model could not answer.");
    scriptedReply = false;
  } finally {
    clearThinkCue();
    if (capsule.dataset.activity !== "saved") setActivity("");
    if (keepMemory && !remembered) rememberTurn(question, answer);
    if (activeReader === reader) activeReader = null;
    brainBusy = false;
    if (!connected) setBusy(false);
    syncCallButtons();
  }
}

function addBrainUsage(usage) {
  chat.brainInput += usage.inputTokens || 0;
  chat.brainOutput += usage.outputTokens || 0;
  chat.thinking += usage.reasoningTokens || 0;
  renderChat();
  // Keep this question's own total on its answer, even after the next question.
  stampQuestionUsage(currentAnswerBubble, usage);
}

function stampQuestionUsage(bubble, usage) {
  if (!bubble || !usage) return;
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  let line = bubble.querySelector(".usage");
  if (!line) {
    line = document.createElement("p");
    line.className = "usage";
    bubble.append(line);
  }
  line.textContent = `This question: ${total.toLocaleString()} tokens · ${formatUsd(usage.usd || 0)}`;
}

function sendEvent(payload) {
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(payload));
}

function clearEmptyHint() {
  transcriptEl.querySelector(".empty")?.remove();
}

function addBubble(role, text, partial) {
  clearEmptyHint();
  const bubble = document.createElement("article");
  bubble.className = `bubble ${role}${partial ? " partial" : ""}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You"
    : role === "note" ? "Medical"
    : role === "meeting" ? "Meeting"
    : role === "lecture" ? "Lecture"
    : role === "recap" ? "Recap"
    : "Brain";
  const body = document.createElement("p");
  body.className = "text";
  body.textContent = text;
  bubble.append(who, body);
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return bubble;
}

function appendAssistantPartial(delta) {
  if (!assistantPartialEl) assistantPartialEl = addBubble("assistant", "", true);
  assistantPartialEl.querySelector(".text").textContent += delta;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function updateUserPartial(text) {
  const question = questionAfterWake(text) || (keyboardWake ? wordsFromKey(text) : "");
  if (!question) {
    if (userPartialEl) {
      userPartialEl.remove();
      userPartialEl = null;
    }
    return;
  }
  if (!userPartialEl) userPartialEl = addBubble("user", question, true);
  else userPartialEl.querySelector(".text").textContent = question;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeUser(text) {
  if (userPartialEl) {
    userPartialEl.querySelector(".text").textContent = text;
    userPartialEl.classList.remove("partial");
    userPartialEl = null;
  } else {
    addBubble("user", text, false);
  }
}

function setStatus(text) { statusText.textContent = text; }
function setCapsuleState(state) { capsule.dataset.state = state; }
// What Tiny is doing for the answer: "searching", "writing", "saved", or "".
function setActivity(name) { capsule.dataset.activity = name; }
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
function playTinyMove(text) {
  const q = String(text || "").toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!q || q.split(" ").length > 8) return "";
  if (!/^(?:hey )?(?:tiny )?(?:(?:can|could|will|would) you|please|show me|let's|let us|do a|dance|wave|drink|celebrate|have a (?:coffee|boba|bubble))\b/.test(q)) return "";
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
    name.textContent = `${shortPath(folder.path)}${folder.hasCode ? " · code.md" : ""}`;
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
    kicker.textContent = `Idea · ${item.source || "recent email"}`;
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

/** Highlight the skill that is on. Click a row to turn it on or off. */
function setActiveSkill(id) {
  activeSkillId = id || "";
  renderSkills();
}

function renderSkills() {
  if (!skillList) return;
  skillList.replaceChildren();
  if (!skillCatalog.length) {
    const empty = document.createElement("p");
    empty.className = "skill-empty";
    empty.textContent = "No skills yet. Upload a markdown file.";
    skillList.append(empty);
    return;
  }
  for (const skill of skillCatalog) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "skill-row";
    const on = skill.id === activeSkillId;
    if (on) row.classList.add("is-on");
    row.setAttribute("aria-pressed", on ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = skill.name;
    const about = document.createElement("span");
    about.textContent = skill.description || "No description";
    row.append(title, about);
    row.addEventListener("click", () => {
      if (activeSkillId === skill.id) {
        setActiveSkill("");
        setStatus("Skill off.");
      } else {
        setActiveSkill(skill.id);
        setStatus(`${skill.name} is on. Say Hey, then tell me what to do with it.`);
      }
    });
    skillList.append(row);
  }
}

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

uploadSkillBtn?.addEventListener("click", () => skillFile?.click());
skillFile?.addEventListener("change", async () => {
  const file = skillFile.files?.[0];
  skillFile.value = "";
  if (!file) return;
  setStatus("Adding that skill…");
  try {
    const text = await file.text();
    const response = await fetch("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name.replace(/\.(md|txt)$/i, ""), text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not add that skill.");
    await loadSkills();
    setActiveSkill(data.id || "");
    setStatus(`${data.name || "That skill"} is on. Say Hey, then tell me what to do with it.`);
  } catch (err) {
    console.error("Failed while uploading a skill:", err);
    setStatus(err.message || "Could not add that skill.");
  }
});

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
    const withCode = (data.folders || []).filter((folder) => folder.selected && folder.hasCode).length;
    setStatus(`Using ${data.notes.toLocaleString()} notes. ${withCode} folder${withCode === 1 ? "" : "s"} with code.md.`);
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

addFolderBtn.addEventListener("click", async () => {
  const path = folderPath.value.trim();
  if (!path) return;
  addFolderBtn.disabled = true;
  try {
    const response = await fetch("/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
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
