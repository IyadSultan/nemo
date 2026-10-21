/**
 * Speaking answers: voice control, Kokoro, the Mac voice, and text made ready to say.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

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
      `/session?voice=${encodeURIComponent(speakingVoice())}&model=gpt-realtime-2.1-mini&speak=1`,
      {
        method: "POST",
        body: peer.localDescription?.sdp || offer.sdp,
        headers: { "Content-Type": "application/sdp" },
      }
    );
    const answerBody = await sdpResponse.text();
    if (!sdpResponse.ok) {
      let message = answerBody;
      // 429 means the OpenAI account is out of credits. The server hides the
      // raw billing text, so the status code is what the page can trust.
      let noCredits = sdpResponse.status === 429;
      try {
        const parsed = JSON.parse(answerBody);
        message = parsed.details?.error?.message || parsed.error || answerBody;
        if (Number(parsed.status) === 429) noCredits = true;
      } catch {
        /* keep the raw text */
      }
      if (noCredits || /credit|quota|billing/i.test(message)) {
        voiceBlocked = "OpenAI has no credits left. The voice on this Mac will speak instead. Add credits, then start again.";
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

// Each model has its own speaker, and each speaker has its own voices.
// Claude and GPT speak with OpenAI. Models on this Mac speak with Kokoro.
// Gemini speaks with Google. The Voice menu lists only the voices that speaker can use.
const VOICES = {
  openai: {
    label: "OpenAI voice",
    fallback: "marin",
    groups: [[
      "",
      [
        ["marin", "Marin"],
        ["cedar", "Cedar"],
        ["alloy", "Alloy"],
        ["ash", "Ash"],
        ["ballad", "Ballad"],
        ["coral", "Coral"],
        ["echo", "Echo"],
        ["sage", "Sage"],
        ["shimmer", "Shimmer"],
        ["verse", "Verse"],
      ],
    ]],
  },
  kokoro: {
    label: "Voice on this Mac",
    fallback: "af_heart",
    groups: [
      ["American", [
        ["af_heart", "Heart"],
        ["af_bella", "Bella"],
        ["af_nicole", "Nicole"],
        ["af_nova", "Nova"],
        ["af_sarah", "Sarah"],
        ["af_sky", "Sky"],
        ["am_adam", "Adam"],
        ["am_michael", "Michael"],
        ["am_puck", "Puck"],
      ]],
      ["British", [
        ["bf_emma", "Emma"],
        ["bf_isabella", "Isabella"],
        ["bm_george", "George"],
        ["bm_fable", "Fable"],
      ]],
    ],
  },
  gemini: {
    label: "Gemini voice",
    fallback: "Aoede",
    groups: [[
      "",
      [
        ["Aoede", "Aoede"],
        ["Charon", "Charon"],
        ["Fenrir", "Fenrir"],
        ["Kore", "Kore"],
        ["Puck", "Puck"],
        ["Leda", "Leda"],
        ["Orus", "Orus"],
        ["Zephyr", "Zephyr"],
      ],
    ]],
  },
};

// Older pages stored only the Mac voice. Keep that choice for Kokoro.
if (!localStorage.getItem("voice:kokoro") && localStorage.getItem("kokoroVoice")) {
  localStorage.setItem("voice:kokoro", localStorage.getItem("kokoroVoice"));
}

/** Which speaker will read the answer for the model picked right now. */
function speakerKind() {
  const model = typeof selectedModel === "function" ? selectedModel() : null;
  if (model?.gemini) return "gemini";
  if (model?.local) return "kokoro";
  return "openai";
}

/** The name shown in the Voice menu, such as Cedar or Heart. */
function voiceLabel() {
  const value = speakingVoice();
  for (const book of Object.values(VOICES)) {
    for (const [, options] of book.groups) {
      const found = options.find(([id]) => id === value);
      if (found) return found[1];
    }
  }
  return value;
}

/** The voice name to send. Always one the current speaker knows. */
function speakingVoice() {
  const kind = speakerKind();
  const book = VOICES[kind];
  const chosen = voiceSelect.value;
  const known = book.groups.some(([, options]) => options.some(([value]) => value === chosen));
  return known ? chosen : (localStorage.getItem(`voice:${kind}`) || book.fallback);
}

/** Rebuild the Voice menu for the model that is picked, and restore that speaker's last choice. */
function fillVoices() {
  const kind = speakerKind();
  const book = VOICES[kind];
  const saved = localStorage.getItem(`voice:${kind}`) || book.fallback;
  voiceSelect.replaceChildren();
  for (const [group, options] of book.groups) {
    const parent = group ? document.createElement("optgroup") : voiceSelect;
    if (group) parent.label = group;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      parent.append(option);
    }
    if (group) voiceSelect.append(parent);
  }
  voiceSelect.value = saved;
  if (!voiceSelect.value) voiceSelect.value = book.fallback;
  voiceSelect.setAttribute("aria-label", book.label);
  voiceSelect.title = "End the call before you change this. The next answer uses the voice you pick.";
  localStorage.setItem(`voice:${kind}`, voiceSelect.value);
}

voiceSelect.addEventListener("change", () => {
  localStorage.setItem(`voice:${speakerKind()}`, voiceSelect.value);
});

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
        body: JSON.stringify({ text, voice: speakingVoice() }),
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
            setStatus(`Speaking as ${voiceLabel()}.`);
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
