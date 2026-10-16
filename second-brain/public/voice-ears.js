/**
 * Listening: the wake word, recording until silence, transcription, and the microphone choice.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

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

