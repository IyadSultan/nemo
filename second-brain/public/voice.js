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
const handledCalls = new Set();
const countedResponses = new Set();
let catalog = null;
let defaultModelId = "gpt-oss:20b";
let chat = emptyChat();

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
    return;
  }
  await startCall();
});

function syncCallButtons() {
  pauseBtn.disabled = !connected;
  stopBtn.disabled = !connected;
  restartBtn.disabled = !lastQuestion;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  pauseBtn.classList.toggle("is-muted", paused);
}

function stopSpeaking() {
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
  try { activeReader?.cancel(); } catch { /* the answer already finished */ }
  if (micStream) {
    for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  }
  syncCallButtons();
  setStatus("Say Hey my brain, then your new question.");
  setCapsuleState(muted ? "muted" : "listening");
}

pauseBtn.addEventListener("click", () => {
  if (!connected) return;
  listenForNewQuestion();
});

stopBtn.addEventListener("click", () => {
  if (!connected) return;
  listenForNewQuestion();
});

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
  transcriptEl.innerHTML = '<p class="empty">Press Start talking. Say Hey my brain, then your question.</p>';
  assistantPartialEl = null;
  userPartialEl = null;
});

let localStop = false;

async function startCall() {
  setBusy(true);
  setStatus("Connecting…");
  setCapsuleState("connecting");
  talkLabel.textContent = "Connecting…";
  chat = emptyChat();
  countedResponses.clear();
  renderChat();

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

const WAKE_STATUS = "Listening. I only answer when you start with Hey my brain.";

/**
 * The words after "Hey my brain", or null when the phrase is not at the start.
 * An empty string means they said only the wake phrase.
 */
function questionAfterWake(text) {
  const cleaned = String(text || "").replace(/^[\s"'“”]+/, "").trim();
  const match = cleaned.match(/^hey\s+my\s+brain\b[\s,.:;!?\-]*/i);
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
        quietSince = 0;
      } else if (heard && now - started > 400) {
        if (!quietSince) quietSince = now;
        if (now - quietSince > 650) finish();
      }
      if (now - started > 15000) finish();
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
    if (!connected || localStop || paused) continue;
    if (!clip || clip.size < 2000) continue;

    setStatus("Writing down what you said…");
    setCapsuleState("thinking");
    let text = "";
    try {
      const response = await fetch("/transcribe", {
        method: "POST",
        headers: { "Content-Type": clip.type || "audio/webm" },
        body: clip,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The local voice model could not hear that.");
      text = (data.text || "").trim();
    } catch (err) {
      console.error("Failed while transcribing locally:", err);
      setStatus(err.message || "The local voice model could not hear that.");
      await sleep(600);
      continue;
    }
    if (looksLikeSilence(text)) {
      setStatus(WAKE_STATUS);
      setCapsuleState("listening");
      continue;
    }
    const question = questionAfterWake(text);
    // No wake phrase, or only the phrase with no question: stay quiet.
    if (!question) {
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
    active = true;
    s.channel.send(JSON.stringify({
      type: "response.create",
      response: {
        // Out of band, with no history: each piece costs only its own tokens.
        conversation: "none",
        input: [],
        output_modalities: ["audio"],
        max_output_tokens: 4096,
        instructions: `Read this text aloud exactly, from the first word to the last. Do not summarize. Do not add anything.\n\n${queue.shift()}`,
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
    end() {
      ended = true;
      // A long answer needs time to be spoken. About 12 characters a second, plus a cushion.
      cap = setTimeout(() => finish(), Math.min(180000, 8000 + totalChars * 90));
      if (!totalChars) finish();
    },
    stop() {
      queue.length = 0;
      ended = true;
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
  setStatus("Speaking with the Kokoro voice.");
  setCapsuleState("speaking");
  let chain = Promise.resolve();
  let stopped = false;
  let playing = null;
  let release = null;
  return (kokoroSpeech = {
    get done() { return chain; },
    push(text) {
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
    end() {},
    stop() {
      stopped = true;
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
  return {
    get done() { return last; },
    push(text) {
      const utterance = new SpeechSynthesisUtterance(text);
      last = new Promise((resolve) => {
        utterance.onend = resolve;
        utterance.onerror = resolve;
      });
      speechSynthesis.speak(utterance);
    },
    end() {},
    stop() { speechSynthesis.cancel(); },
  };
}

/**
 * Last cleanup before a piece is spoken, in case the model still wrote
 * markdown or HTML. The bubble keeps the original text.
 */
function forSpeech(text) {
  return text
    .replace(/<[^>]+>/g, " ")                       // HTML tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")      // [label](link) -> label
    .replace(/https?:\/\/\S+/g, "")                 // bare web addresses
    .replace(/^\s*#{1,6}\s*/gm, "")                 // headings
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")     // list markers
    .replace(/^\s*(?:note|source|sources|file)s?\s*:.*$/gim, "") // trailing source lines
    .replace(/[*_`~|>#]+/g, "")                     // bold, italics, code, tables, quotes
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

async function hangUp({ keepStatus = false } = {}) {
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
    setCapsuleState("listening");
    setStatus("Listening…");
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      assistantPartialEl = null;
    }
    return;
  }
  if (type === "input_audio_buffer.speech_stopped") {
    setStatus("Thinking…");
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
    answerFromNotes(event);
    return;
  }

  if (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "conversation.item.input_audio_transcription.done"
  ) {
    const text = event.transcript || event.item?.content?.[0]?.transcript || "";
    const question = questionAfterWake(text.trim());
    if (!question) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      setStatus(WAKE_STATUS);
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

/** Look up notes, then hand them back so the voice model can speak the answer. */
async function answerFromNotes(event) {
  const item = event.item || event;
  const callId = item.call_id || event.call_id;
  const name = item.name || event.name;
  if (name !== "search_notes" || !callId || handledCalls.has(callId)) return;
  handledCalls.add(callId);

  let query = "";
  try {
    query = JSON.parse(item.arguments || event.arguments || "{}").query || "";
  } catch (err) {
    console.error("Failed while reading the note search:", err);
  }

  setStatus("Looking through your notes…");
  let notes = "No matching notes.";
  try {
    const response = await fetch(`/notes?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    notes = data.notes || notes;
  } catch (err) {
    console.error("Failed while searching notes:", err);
    notes = "The note search failed.";
  }

  sendEvent({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: notes },
  });
  sendEvent({ type: "response.create" });
}

/** Bonsai and GPT-6 write the answer. Voice control is what speaks it. */
async function answerWithBrain(question) {
  if (brainBusy || paused) return;
  lastQuestion = question;
  syncCallButtons();
  brainBusy = true;
  cancelAnswer = false;
  currentAnswerBubble = null;
  askAbort = new AbortController();
  setStatus(`Thinking with ${selectedModel()?.label || "the selected model"}…`);
  // Local models (Bonsai) always use the Kokoro voice on this Mac: free, no OpenAI.
  const macOnly = Boolean(selectedModel()?.local);
  const speakerReady = macOnly ? null : ensureSpeaker();
  speakerReady?.catch(() => {});
  let speech = null;
  let bubble = null;
  let reader = null;
  try {
    const response = await fetch("/ask", {
      method: "POST",
      signal: askAbort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
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
    let answer = "";
    let unspoken = "";
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
        } else if (event.type === "delta") {
          const text = event.text || "";
          answer += text;
          unspoken += text;
          bubble ??= addBubble("assistant", "", true);
          currentAnswerBubble = bubble;
          bubble.querySelector(".text").textContent = answer.trim();
          transcriptEl.scrollTop = transcriptEl.scrollHeight;
        } else if (event.type === "usage") addBrainUsage(event);
        else if (event.type === "ignored") return;
        else if (event.type === "error") throw new Error(event.message || "The selected model failed.");
      }
      await speakReady(false);
    }

    if (cancelAnswer) return;
    if (!answer.trim()) throw new Error("The selected model returned an empty answer.");
    bubble?.classList.remove("partial");
    await speakReady(true);
    speech?.end();
    await speech?.done;
    if (connected && !localStop) {
      setCapsuleState("listening");
      setStatus(macOnly
        ? WAKE_STATUS
        : voiceBlocked
        ? "Listening. Say Hey my brain, then your question. Voice control has no credits, so the Mac voice spoke."
        : WAKE_STATUS);
    }
  } catch (err) {
    speech?.stop();
    if (err?.name === "AbortError") return;
    console.error("Failed while asking the selected model:", err);
    bubble?.classList.remove("partial");
    setStatus(err.message || "The selected model could not answer.");
    scriptedReply = false;
  } finally {
    if (activeReader === reader) activeReader = null;
    brainBusy = false;
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
  fillReasoning();
  showRates();
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
  fillReasoning();
  showRates();
});
reasoningSelect.addEventListener("change", showRates);

loadSettings();
renderChat();
