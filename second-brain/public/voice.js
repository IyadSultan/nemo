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
const remoteAudio = document.getElementById("remoteAudio");
const folderList = document.getElementById("folderList");
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
let queuedQuestion = "";
let micBusy = false;
const handledCalls = new Set();
const countedResponses = new Set();
let catalog = null;
let defaultModelId = "gpt-oss:20b";
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
    await hangUp();
    clearChatMemory();
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
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  pauseBtn.classList.toggle("is-muted", paused);
}

function stopSpeaking() {
  clearThinkCue();
  activeSpeech?.stop();
  kokoroSpeech?.stop();
  speechSynthesis.cancel();
  try { remoteAudio.pause(); } catch { /* nothing is playing */ }
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "response.cancel" }));
  }
}

function listenForNewQuestion() {
  // Drop the answer that is playing, keep the call, and wait for a new wake phrase.
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
    setStatus("Say Hey, then your new question.");
    setCapsuleState(muted ? "muted" : "listening");
  } else {
    setStatus("Type a question, or press Start talking.");
    setCapsuleState("idle");
  }
}

pauseBtn.addEventListener("click", () => {
  if (!connected) return;
  listenForNewQuestion();
});

stopBtn.addEventListener("click", () => {
  if (!connected && !brainBusy) return;
  listenForNewQuestion();
});

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
  questionEndedAt = performance.now();

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
    setStatus(muted ? "Mic muted" : "Listening…");
    setCapsuleState(muted ? "idle" : "listening");
  }
});

clearBtn.addEventListener("click", () => {
  transcriptEl.innerHTML = '<p class="empty">Press Start talking and say Hey, or type a question below the orb.</p>';
  assistantPartialEl = null;
  userPartialEl = null;
  chatTurns = [];
  chatMemory = "";
  compressAbort?.abort();
});

let chosenModelId = "";
let chatTurns = [];
let chatMemory = "";
let compressAbort = null;
let compressGen = 0;
let localStop = false;

function rememberTurn(question, answer) {
  const asked = String(question || "").trim();
  if (!asked) return;
  chatTurns.push({
    question: asked,
    answer: String(answer || "").trim() || "(The answer was stopped.)",
  });
  if (chatTurns.length > 8) chatTurns = chatTurns.slice(-8);
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
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

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
    setStatus(WAKE_STATUS);
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

const WAKE_STATUS = "Listening. I only answer when you start with Hey.";
// A short breath is not the end of the sentence. Wait this long before stopping the recording.
const END_PAUSE_MS = 1200;

/**
 * The words after "Hey", or null when the sentence does not start with Hey.
 * "Hey my brain" still works. An empty string means they said only Hey.
 */
function questionAfterWake(text) {
  const cleaned = String(text || "").replace(/^[\s"'“”]+/, "").trim();
  const match = cleaned.match(/^hey\b(?:\s+my\s+brain\b)?[\s,.:;!?\-]*/i);
  if (!match) return null;
  return cleaned.slice(match[0].length).trim();
}

/** Whisper sometimes invents these on a quiet room. Ignore them. */
function looksLikeSilence(text) {
  const raw = String(text || "").trim();
  // A whole caption in parentheses is a sound, such as (door opens) or (sighs).
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\w\s']/g, "")
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
        discard = true;
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
        settled = true;
        resolve(new Blob());
      }
    }
  });
}

async function transcribeClip(clip) {
  const response = await fetch("/transcribe", {
    method: "POST",
    headers: { "Content-Type": clip.type || "audio/webm" },
    body: clip,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The local voice model could not hear that.");
  return (data.text || "").trim();
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
      if (questionAfterWake(text) === null && !/\bhey\b/i.test(text)) return;
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
    pendingSlice = { index, blob: event.data };
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
          const question = questionAfterWake(text);
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

/**
 * Bonsai and GPT-6: the Mac listens, that model writes, voice control speaks.
 */
async function startLocalListen() {
  localStop = false;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  connected = true;
  voiceSelect.disabled = true;
  modelSelect.disabled = true;
  reasoningSelect.disabled = true;
  muteBtn.disabled = false;
  syncCallButtons();
  talkBtn.setAttribute("aria-pressed", "true");
  talkLabel.textContent = "End call";
  const macOnly = Boolean(selectedModel()?.local);
  setStatus(WAKE_STATUS);
  setCapsuleState("listening");
  setBusy(false);
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
    if (queuedQuestion) {
      const question = queuedQuestion;
      queuedQuestion = "";
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
    setStatus(WAKE_STATUS);
    setCapsuleState("listening");
    const clip = await recordUntilSilence(micStream);
    if (!connected || localStop || paused) {
      clearThinkCue();
      continue;
    }
    if (!clip || clip.size < 2000) {
      clearThinkCue();
      continue;
    }

    setStatus("Writing down what you said…");
    setCapsuleState("thinking");
    let text = "";
    try {
      text = await transcribeClip(clip);
    } catch (err) {
      console.error("Failed while transcribing locally:", err);
      clearThinkCue();
      setStatus(err.message || "The local voice model could not hear that.");
      await sleep(600);
      continue;
    }
    if (looksLikeSilence(text)) {
      clearThinkCue();
      setStatus(WAKE_STATUS);
      setCapsuleState("listening");
      continue;
    }
    const question = questionAfterWake(text);
    // No wake phrase, or only the phrase with no question: stay quiet.
    if (!question) {
      clearThinkCue();
      setStatus(WAKE_STATUS);
      setCapsuleState("listening");
      continue;
    }
    addBubble("user", question, false);
    await answerWithBrain(question);
  }
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
      const clip = fetch("/speak", {
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
          console.error("Failed while speaking with Kokoro, using the Mac voice:", err);
          if (stopped) return;
          const utterance = new SpeechSynthesisUtterance(text);
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
      ? "Call ended. Local models were stopped and the chat memory was cleared."
      : "Call ended. Chat memory was cleared. No local model was using memory.");
  } catch (err) {
    console.error("Failed while stopping local models:", err);
    setStatus("Call ended. Chat memory was cleared, but a local model may still be in memory.");
  }
}
async function hangUp({ keepStatus = false } = {}) {
  // Stop the answer first, so Ollama is free to unload the model.
  listenEpoch += 1;
  cancelAnswer = true;
  askAbort?.abort();
  compressAbort?.abort();
  compressGen += 1;
  stopSpeaking();
  connected = false;
  localStop = true;
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
    questionEndedAt = performance.now();
    // Models that do not hear for themselves beep while the answer is prepared.
    if (needsVoiceControl(selectedModel())) armThinkCue(questionEndedAt);
    setStatus("Thinking…");
    setCapsuleState("thinking");
    return;
  }
  if (type === "response.created" || type === "response.output_item.added") {
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
      setCapsuleState("listening");
      setStatus("Listening… speak anytime");
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
    const question = questionAfterWake(text.trim());
    if (question === null) {
      clearThinkCue();
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      setStatus(WAKE_STATUS);
      return;
    }
    stopSpeaking();
    if (!question) {
      setStatus("Go ahead. A short pause is fine.");
      setCapsuleState("listening");
      return;
    }
    finalizeUser(question);
    if (selectedModel()?.hears) sendEvent({ type: "response.create" });
    else if (needsVoiceControl(selectedModel())) answerWithBrain(question);
    return;
  }
  if (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "conversation.item.input_audio_transcription.partial"
  ) {
    const text = event.delta || event.transcript || "";
    if (text) updateUserPartial(text);
    return;
  }
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    if (!scriptedReply && event.delta) appendAssistantPartial(event.delta);
    return;
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    if (scriptedReply) return;
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      if (event.transcript) assistantPartialEl.querySelector(".text").textContent = event.transcript;
      assistantPartialEl = null;
    } else if (event.transcript) {
      addBubble("assistant", event.transcript, false);
    }
  }
}

/** Run a tool the voice model asked for, then hand the result back. */
async function answerToolCall(event) {
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
 * A reply has two parts. The voice reads the words before EMAIL_BODY.
 * The words after it are the letter that Outlook opens.
 * While the answer is still arriving, hold back a half-written EMAIL_BODY
 * so the voice does not say it.
 */
function splitEmailDraft(raw, finished) {
  const match = /EMAIL_BODY/i.exec(raw);
  if (match) {
    const spoken = raw.slice(0, match.index);
    const written = raw.slice(match.index + match[0].length).replace(/^[\s:—-]+/, "");
    return {
      spoken: finished ? spoken.trim() : spoken,
      written: finished ? written.trim() : written,
      closed: true,
    };
  }
  if (!finished) {
    const upper = raw.toUpperCase();
    const token = "EMAIL_BODY";
    for (let size = token.length - 1; size > 3; size -= 1) {
      if (upper.endsWith(token.slice(0, size))) {
        return { spoken: raw.slice(0, -size), written: "", closed: false };
      }
    }
  }
  return { spoken: finished ? raw.trim() : raw, written: "", closed: false };
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
async function answerWithBrain(question) {
  if (brainBusy || paused) return;
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
        } else if (event.type === "outlook") {
          outlook = {
            to: event.to || "",
            subject: event.subject || "",
            name: event.name || "",
            original: event.original || "",
          };
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
          bubble.querySelector(".text").textContent = spokenShown.trim();
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
      bubble.querySelector(".text").textContent = spoken || written;
    }
    if (outlook) attachOutlookButton(bubble, outlook, written || spoken);
    rememberTurn(question, answer);
    remembered = true;
    compressWhileSpeaking();
    await speakReady(true);
    speech?.end();
    await speech?.done;
    if (connected && !localStop) {
      setCapsuleState("listening");
      setStatus(macOnly
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
  who.textContent = role === "user" ? "You" : "Brain";
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
  const question = questionAfterWake(text);
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
