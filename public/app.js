/**
 * Browser client for OpenAI Realtime (WebRTC).
 *
 * Flow in plain words:
 * 1. You click Start talking → we ask for microphone access.
 * 2. We create a WebRTC connection and send an "offer" to our Node server.
 * 3. The server talks to OpenAI with your secret API key and returns an "answer".
 * 4. Mic audio goes to OpenAI; the assistant's voice comes back into <audio>.
 * 5. Events on a data channel give us transcripts and speaking/listening status.
 */

const talkBtn = document.getElementById("talkBtn");
const talkLabel = document.getElementById("talkLabel");
const statusText = document.getElementById("statusText");
const capsule = document.getElementById("capsule");
const voiceSelect = document.getElementById("voiceSelect");
const muteBtn = document.getElementById("muteBtn");
const clearBtn = document.getElementById("clearBtn");
const transcriptEl = document.getElementById("transcript");
const remoteAudio = document.getElementById("remoteAudio");

/** @type {RTCPeerConnection | null} */
let pc = null;
/** @type {RTCDataChannel | null} */
let dc = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {HTMLParagraphElement | null} */
let assistantPartialEl = null;
/** @type {HTMLParagraphElement | null} */
let userPartialEl = null;

let connected = false;
let muted = false;

talkBtn.addEventListener("click", async () => {
  if (connected) {
    await hangUp();
    return;
  }
  await startCall();
});

muteBtn.addEventListener("click", () => {
  if (!micStream) return;
  muted = !muted;
  for (const track of micStream.getAudioTracks()) {
    track.enabled = !muted;
  }
  muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
  muteBtn.classList.toggle("is-muted", muted);
  if (connected) {
    setStatus(muted ? "Mic muted — assistant can still speak" : "Listening…");
    setCapsuleState(muted ? "idle" : "listening");
  }
});

clearBtn.addEventListener("click", () => {
  transcriptEl.innerHTML =
    '<p class="empty">Your conversation will appear here as you talk.</p>';
  assistantPartialEl = null;
  userPartialEl = null;
});

async function startCall() {
  setBusy(true);
  setStatus("Connecting…");
  setCapsuleState("connecting");
  talkLabel.textContent = "Connecting…";

  try {
    // 1) Microphone
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 2) WebRTC peer connection
    pc = new RTCPeerConnection();

    // Play assistant audio
    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      // Some browsers need an explicit play() after a user gesture
      remoteAudio.play().catch(() => {
        /* autoplay may still work via the user click that started the call */
      });
    };

    // Send mic tracks to OpenAI
    for (const track of micStream.getTracks()) {
      pc.addTrack(track, micStream);
    }

    // 3) Data channel for transcripts / control events
    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", () => {
      // Reinforce natural turn-taking + transcription after connect
      sendEvent({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions:
            "You are Nemo, a friendly real-time voice assistant. Speak naturally in short turns, like a phone call. Prefer clear, warm spoken English unless the user uses another language. If interrupted, stop and listen, then respond to the new request.",
          audio: {
            input: {
              turn_detection: {
                type: "semantic_vad",
                interrupt_response: true,
              },
              transcription: {
                model: "gpt-4o-mini-transcribe",
              },
            },
          },
        },
      });
    });
    dc.addEventListener("message", (event) => {
      handleServerEvent(safeParse(event.data));
    });

    // 4) SDP offer → our server → OpenAI → SDP answer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait briefly for ICE gathering on simple setups (helps some networks)
    await waitForIceGathering(pc, 1500);

    const voice = voiceSelect.value;
    const sdpResponse = await fetch(`/session?voice=${encodeURIComponent(voice)}`, {
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
        /* keep raw text */
      }
      throw new Error(message || `Session failed (${sdpResponse.status})`);
    }

    await pc.setRemoteDescription({ type: "answer", sdp: answerBody });

    connected = true;
    voiceSelect.disabled = true;
    muteBtn.disabled = false;
    talkBtn.setAttribute("aria-pressed", "true");
    talkLabel.textContent = "End call";
    setStatus("Listening… speak anytime");
    setCapsuleState("listening");
    setBusy(false);
  } catch (err) {
    console.error(err);
    setStatus(humanError(err));
    setCapsuleState("idle");
    await hangUp({ keepStatus: true });
    setBusy(false);
  }
}

async function hangUp({ keepStatus = false } = {}) {
  connected = false;
  muted = false;

  try {
    dc?.close();
  } catch {
    /* ignore */
  }
  dc = null;

  try {
    pc?.getSenders().forEach((sender) => sender.track?.stop());
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  remoteAudio.srcObject = null;
  assistantPartialEl = null;
  userPartialEl = null;

  talkBtn.setAttribute("aria-pressed", "false");
  talkLabel.textContent = "Start talking";
  voiceSelect.disabled = false;
  muteBtn.disabled = true;
  muteBtn.textContent = "Mute mic";
  muteBtn.classList.remove("is-muted");
  setCapsuleState("idle");
  setBusy(false);

  if (!keepStatus) {
    setStatus("Call ended");
  }
}

function handleServerEvent(event) {
  if (!event || typeof event !== "object") return;

  const type = event.type;

  // --- Connection / speech lifecycle ---
  if (type === "session.created" || type === "session.updated") {
    // no-op; useful for debugging
    return;
  }

  if (type === "input_audio_buffer.speech_started") {
    // User started talking (possible barge-in)
    setCapsuleState("listening");
    setStatus("Listening…");
    // Clear in-progress assistant text when interrupted
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

  if (
    type === "response.done" ||
    type === "response.output_audio.done" ||
    type === "output_audio_buffer.stopped"
  ) {
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
    const msg =
      event.error?.message || event.message || "Realtime API error";
    console.error("Realtime error event:", event);
    setStatus(msg);
    return;
  }

  // --- Transcripts (handle a few event name variants) ---

  // User speech transcript (final)
  if (
    type === "conversation.item.input_audio_transcription.completed" ||
    type === "conversation.item.input_audio_transcription.done"
  ) {
    const text = event.transcript || event.item?.content?.[0]?.transcript || "";
    if (text.trim()) {
      finalizeUser(text.trim());
    }
    return;
  }

  // User speech transcript (partial / delta)
  if (
    type === "conversation.item.input_audio_transcription.delta" ||
    type === "conversation.item.input_audio_transcription.partial"
  ) {
    const text = event.delta || event.transcript || "";
    if (text) updateUserPartial(text);
    return;
  }

  // Assistant transcript streaming
  if (
    type === "response.output_audio_transcript.delta" ||
    type === "response.audio_transcript.delta"
  ) {
    const delta = event.delta || "";
    if (delta) appendAssistantPartial(delta);
    return;
  }

  if (
    type === "response.output_audio_transcript.done" ||
    type === "response.audio_transcript.done"
  ) {
    if (assistantPartialEl) {
      assistantPartialEl.classList.remove("partial");
      // Prefer final full transcript if provided
      const finalText = event.transcript;
      if (finalText) {
        assistantPartialEl.querySelector(".text").textContent = finalText;
      }
      assistantPartialEl = null;
    } else if (event.transcript) {
      addBubble("assistant", event.transcript, false);
    }
  }
}

function sendEvent(payload) {
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify(payload));
  }
}

function clearEmptyHint() {
  const empty = transcriptEl.querySelector(".empty");
  if (empty) empty.remove();
}

function addBubble(role, text, partial) {
  clearEmptyHint();
  const bubble = document.createElement("article");
  bubble.className = `bubble ${role}${partial ? " partial" : ""}`;
  bubble.innerHTML = `
    <div class="who">${role === "user" ? "You" : "Nemo"}</div>
    <p class="text"></p>
  `;
  bubble.querySelector(".text").textContent = text;
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return bubble;
}

function appendAssistantPartial(delta) {
  if (!assistantPartialEl) {
    assistantPartialEl = addBubble("assistant", "", true);
  }
  const textEl = assistantPartialEl.querySelector(".text");
  textEl.textContent += delta;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function updateUserPartial(text) {
  // Some APIs send cumulative partials, some send deltas — treat as cumulative
  if (!userPartialEl) {
    userPartialEl = addBubble("user", text, true);
  } else {
    userPartialEl.querySelector(".text").textContent = text;
  }
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

function setStatus(text) {
  statusText.textContent = text;
}

function setCapsuleState(state) {
  capsule.dataset.state = state;
}

function setBusy(busy) {
  talkBtn.disabled = busy;
}

function waitForIceGathering(peer, timeoutMs) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }
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
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function humanError(err) {
  const msg = err?.message || String(err);
  if (/Permission|NotAllowed/i.test(msg)) {
    return "Microphone permission denied. Allow the mic and try again.";
  }
  if (/OPENAI_API_KEY|Missing/i.test(msg)) {
    return "Server is missing OPENAI_API_KEY. Add it to your .env file.";
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return "Could not reach the local server. Is npm start running?";
  }
  return msg;
}

// End cleanly if the tab closes
window.addEventListener("beforeunload", () => {
  if (connected) {
    hangUp({ keepStatus: true });
  }
});
