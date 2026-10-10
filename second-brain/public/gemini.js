/**
 * Gemini Live: Google hears you and speaks back on one voice line.
 *
 * - The server mints a short-lived token (/gemini-session); the API key stays there.
 * - The mic is sent as 16 kHz 16-bit PCM over a WebSocket; replies come back as 24 kHz PCM.
 * - Talking over Gemini cuts it off: Google sends "interrupted" and the queued audio is dropped.
 * - Gemini can call search_notes and here_and_now, the same tools Voice mini uses.
 *
 * Uses page state and helpers from voice.js (micStream, connected, muted, chat, addBubble, ...).
 */
let gemini = null;

const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

// Runs on the audio thread: mic samples -> 16-bit PCM, sent in ~100 ms pieces.
const PCM_WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.size = 0; }
  process(inputs) {
    const samples = inputs[0][0];
    if (samples) {
      this.parts.push(new Float32Array(samples));
      this.size += samples.length;
      if (this.size >= 1600) {
        const out = new Int16Array(this.size);
        let at = 0;
        for (const part of this.parts) {
          for (let i = 0; i < part.length; i += 1) {
            const s = Math.max(-1, Math.min(1, part[i]));
            out[at++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
        }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.parts = [];
        this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);
`;

function pcmToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function base64ToPcm(b64) {
  const text = atob(b64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

async function startGeminiCall() {
  const response = await fetch(
    `/gemini-session?model=${encodeURIComponent(modelSelect.value)}&voice=${encodeURIComponent(voiceSelect.value)}`,
    { method: "POST" }
  );
  const session = await response.json();
  if (!response.ok) throw new Error(session.error || "Gemini did not start.");

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const micCtx = new AudioContext({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" })));
  const worklet = new AudioWorkletNode(micCtx, "pcm16");
  micCtx.createMediaStreamSource(micStream).connect(worklet);

  const g = {
    ws: new WebSocket(`${GEMINI_WS}?access_token=${encodeURIComponent(session.token)}`),
    micCtx,
    playCtx: new AudioContext({ sampleRate: 24000 }),
    worklet,
    playing: new Set(),
    playAt: 0,
    ready: false,
    speaking: false,
    userBubble: null,
    userHeardAt: 0,
  };
  gemini = g;

  worklet.port.onmessage = (event) => {
    if (!g.ready || muted || paused || g.ws.readyState !== WebSocket.OPEN) return;
    g.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcmToBase64(event.data), mimeType: "audio/pcm;rate=16000" } } }));
  };

  await new Promise((resolve, reject) => {
    g.ws.onopen = () => g.ws.send(JSON.stringify({ setup: session.setup }));
    g.ws.onerror = () => reject(new Error("The Gemini line failed to open."));
    g.ws.onmessage = async (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : await event.data.text());
      if (msg.setupComplete) {
        g.ready = true;
        resolve();
      }
      handleGeminiMessage(g, msg);
    };
    g.ws.onclose = (event) => {
      reject(new Error(event.reason || "Gemini closed the line."));
      if (gemini === g && connected) {
        setStatus(`Gemini ended the call${event.reason ? `: ${event.reason}` : ""}.`);
        hangUp({ keepStatus: true });
      }
    };
  });

  connected = true;
  voiceSelect.disabled = true;
  modelSelect.disabled = true;
  reasoningSelect.disabled = true;
  muteBtn.disabled = false;
  syncCallButtons();
  talkBtn.setAttribute("aria-pressed", "true");
  talkLabel.textContent = "End call";
  setStatus("Listening. Talk over Gemini to cut it off.");
  setCapsuleState("listening");
}

function stopGeminiCall() {
  const g = gemini;
  gemini = null;
  if (!g) return;
  stopGeminiAudio(g);
  try { g.ws.close(); } catch { /* already closed */ }
  try { g.worklet.disconnect(); } catch { /* already disconnected */ }
  g.micCtx.close().catch(() => {});
  g.playCtx.close().catch(() => {});
}

/** Stop button or shortcut: drop what is queued, and the rest of this answer as it arrives. */
function silenceGeminiTurn() {
  if (!gemini) return;
  stopGeminiAudio(gemini);
  gemini.silenced = true;
}

/** Drop every queued piece of the answer (barge-in, Stop button, hang-up). */
function stopGeminiAudio(g = gemini) {
  if (!g) return;
  for (const source of g.playing) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  g.playing.clear();
  g.playAt = 0;
  g.speaking = false;
}

function playGeminiPcm(g, b64) {
  const pcm = base64ToPcm(b64);
  const buffer = g.playCtx.createBuffer(1, pcm.length, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
  const source = g.playCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(g.playCtx.destination);
  const now = g.playCtx.currentTime;
  g.playAt = Math.max(g.playAt, now + 0.05);
  source.start(g.playAt);
  g.playAt += buffer.duration;
  g.playing.add(source);
  source.onended = () => {
    g.playing.delete(source);
    if (!g.playing.size && gemini === g && connected) {
      g.speaking = false;
      setStatus("Listening. Talk over Gemini to cut it off.");
      setCapsuleState(muted ? "muted" : "listening");
    }
  };
}

async function answerGeminiTools(g, calls) {
  // Gemini often says "let me check" before a tool call. Reset, so the answer after the tool sets "speaking" again.
  g.speaking = false;
  setCapsuleState("thinking");
  setStatus("Searching your notes…");
  const functionResponses = [];
  for (const call of calls) {
    let result = "";
    try {
      if (call.name === "here_and_now") {
        result = (await (await fetch("/here")).json()).text;
      } else if (call.name === "search_notes") {
        const query = String(call.args?.query || "");
        result = (await (await fetch(`/notes?q=${encodeURIComponent(query)}`)).json()).notes;
      } else {
        result = `Unknown tool ${call.name}.`;
      }
    } catch (err) {
      console.error(`Failed while running ${call.name} for Gemini:`, err);
      result = "The tool failed. Say you could not check right now.";
    }
    functionResponses.push({ id: call.id, name: call.name, response: { result } });
  }
  if (gemini === g && g.ws.readyState === WebSocket.OPEN) {
    g.ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
  }
}

function addGeminiUsage(usage) {
  const sum = (details, modality) =>
    (details || []).filter((d) => d.modality === modality).reduce((n, d) => n + (d.tokenCount || 0), 0);
  const thoughts = usage.thoughtsTokenCount || 0;
  chat.input += usage.promptTokenCount || 0;
  chat.output += (usage.responseTokenCount || 0) + thoughts;
  chat.thinking += thoughts;
  chat.textIn += sum(usage.promptTokensDetails, "TEXT");
  chat.audioIn += sum(usage.promptTokensDetails, "AUDIO");
  // Thinking is billed as text output.
  chat.textOut += sum(usage.responseTokensDetails, "TEXT") + thoughts;
  chat.audioOut += sum(usage.responseTokensDetails, "AUDIO");
  renderChat();
}

function handleGeminiMessage(g, msg) {
  if (gemini !== g) return;
  if (msg.usageMetadata) addGeminiUsage(msg.usageMetadata);
  if (msg.toolCall?.functionCalls?.length) answerGeminiTools(g, msg.toolCall.functionCalls);

  const content = msg.serverContent;
  if (!content) return;

  if (content.interrupted) {
    g.silenced = false;
    stopGeminiAudio(g);
    assistantPartialEl?.classList.remove("partial");
    assistantPartialEl = null;
    setStatus("Go ahead.");
    setCapsuleState("listening");
  }

  const heard = content.inputTranscription?.text;
  if (heard) {
    g.userHeardAt = performance.now();
    if (!g.userBubble) g.userBubble = addBubble("user", "", true);
    g.userBubble.querySelector(".text").textContent += heard;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  for (const part of content.modelTurn?.parts || []) {
    if (!part.inlineData?.data || g.silenced) continue;
    if (!g.speaking) {
      g.speaking = true;
      if (g.userHeardAt) questionEndedAt = g.userHeardAt;
      markAnswerStarted();
      setStatus("Speaking. Talk over it to cut it off.");
      setCapsuleState("speaking");
    }
    playGeminiPcm(g, part.inlineData.data);
  }

  const said = content.outputTranscription?.text;
  if (said) {
    if (g.userBubble) {
      g.userBubble.classList.remove("partial");
      lastQuestion = g.userBubble.querySelector(".text").textContent.trim();
      g.userBubble = null;
    }
    appendAssistantPartial(said);
  }

  if (content.turnComplete) {
    g.silenced = false;
    assistantPartialEl?.classList.remove("partial");
    assistantPartialEl = null;
  }
}
