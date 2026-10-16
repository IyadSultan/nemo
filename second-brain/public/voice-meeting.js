/**
 * Meetings and lectures: writing the words down as they are said.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

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
  const base = `${captureName()}. I'm writing down every word and staying quiet.`;
  // No call yet: the summary is shown later, and it is not read aloud.
  return connected ? base : `${base} The summary stays on the screen.`;
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
  // Both work before Start talking. They wait only while a summary is being written.
  meetingBtn.disabled = meetingSummaryBusy || lecture;
  lectureBtn.disabled = meetingSummaryBusy || meeting;
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
  followTranscript();
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
  const base = captureKind === "lecture"
    ? "Lecture. I am writing the words as they are said, in Arabic or English."
    : MEETING_STATUS;
  setStatus(connected ? base : `${base} The summary stays on the screen.`);
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
  followTranscript();
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
      if (epoch !== listenEpoch || localStop || !meetingOn || (!connected && !quietCapture)) {
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
 * A question typed during a meeting or lecture. The answer is shown, not spoken,
 * so the room is not interrupted, and what was said so far is part of the context.
 * Writing the meeting down goes on as before.
 */
async function answerDuringMeeting(question) {
  addBubble("user", question, false);
  const bubble = addBubble("assistant", "…", true);
  const text = bubble.querySelector(".text");
  const kind = captureKind === "lecture" ? "lecture" : "meeting";
  const sofar = [...meetingLines, meetingPartial.trim()].filter(Boolean).join("\n");
  let answer = "";
  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        history: chatTurns,
        memory: chatMemory,
        meetingNotes: [savedMeeting, sofar].filter(Boolean).join("\n"),
        notesKind: kind,
        skill: activeSkillId,
        model: modelSelect.value,
        reasoning: reasoningSelect.value,
        spoken: false,
      }),
    });
    if (!response.ok || !response.body) throw new Error("The brain did not answer.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const events = buffered.split("\n\n");
      buffered = events.pop();
      for (const block of events) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "delta") {
          answer += event.text || "";
          text.textContent = answer;
          followTranscript();
        } else if (event.type === "error") {
          throw new Error(event.message || "The selected model failed.");
        }
      }
    }
    bubble.classList.remove("partial");
    if (!answer.trim()) text.textContent = "I have no answer for that.";
    rememberTurn(question, answer);
  } catch (err) {
    console.error("Failed while answering during the meeting:", err);
    bubble.classList.remove("partial");
    text.textContent = err.message || "I could not answer that.";
  }
  setStatus(`Answered on screen. I'm still writing down the ${kind}.`);
}

/** Record the meeting on its own microphone stream: Opus at 32 kbps, about 14 MB an hour. */
async function startMeetingRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
    const chunks = [];
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.finished = new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(chunks.length ? new Blob(chunks, { type: mime }) : null);
      };
    });
    // Ten-second pieces, so a long lecture is never one huge buffer.
    rec.start(10000);
    return rec;
  } catch (err) {
    console.error("Failed while starting the meeting recording:", err);
    return null;
  }
}

/** Stop the recording (and free the microphone). Resolves with the audio, or null. */
function finishMeetingRecording() {
  const started = meetingRecording;
  meetingRecording = null;
  if (!started) return Promise.resolve(null);
  return started.then((rec) => {
    if (!rec) return null;
    try {
      rec.stop();
    } catch {
      return null;
    }
    return rec.finished;
  });
}

/**
 * Let go of the microphone Meeting or Lecture opened before Start talking.
 * The call then uses that same microphone. The summary is still written.
 */
async function releaseQuietMic() {
  if (!quietCapture && !quietMicBody) return;
  quietHandoff = true;
  quietCapture = false;
  listenEpoch += 1;
  while (recordingClip) await sleep(40);
  if (quietMicBody) await quietMicBody;
  quietHandoff = false;
}

/**
 * Listen and write the words down without starting a call.
 * Start talking is what turns the voice on for the summary. This path does not.
 */
function startQuietMic() {
  if (quietCapture || quietMicBody) return;
  quietCapture = true;
  localStop = false;
  const pending = runQuietMicBody().then((summarize) => {
    // Start talking waits for this whole promise, including the summary,
    // so the call does not listen over the summary.
    if (summarize) return speakMeetingSummary();
  }).catch((err) => {
    console.error("Failed while writing without the call:", err);
  });
  quietMicBody = pending;
  pending.finally(() => {
    if (quietMicBody === pending) quietMicBody = null;
  });
}

/** The microphone loop for a meeting or lecture that started before Start talking. */
async function runQuietMicBody() {
  let summarize = false;
  try {
    if (!micStream) micStream = await openMic();
    muteBtn.disabled = false;
    while (quietCapture && !connected && meetingOn) {
      showMeetingStatus();
      const heard = await captureMeetingLine(micStream);
      const ending = closeMeetingAfterClip && !meetingOn;
      const list = ending && Array.isArray(linesToSummarize) ? linesToSummarize : meetingLines;
      freezeMeetingDraft(heard, list);
      if (ending) summarize = true;
      if (quietHandoff || connected || ending || !quietCapture || !meetingOn) break;
      showMeetingStatus();
    }
    if (!summarize && closeMeetingAfterClip && !meetingOn) summarize = true;
  } catch (err) {
    console.error("Failed while opening the microphone for the meeting:", err);
    setStatus(err.message || "The microphone did not open.");
    if (meetingOn) {
      meetingOn = false;
      captureKind = "";
      closeMeetingAfterClip = false;
      finishMeetingRecording();
      paintMeetingButton();
      setCapsuleState("idle");
    }
    summarize = false;
  } finally {
    quietCapture = false;
    // Start talking keeps this microphone. Ending the meeting releases it.
    if (!quietHandoff && !connected && micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
      muted = false;
      muteBtn.disabled = true;
      muteBtn.textContent = "Mute mic";
      muteBtn.classList.remove("is-muted");
    }
  }
  if (summarize) closeMeetingAfterClip = false;
  return summarize;
}

/**
 * Turn Meeting or Lecture on. This works before Start talking.
 * Any answer that is playing stops. From here, speech is only written down.
 */
function beginMeeting(kind = "meeting") {
  if (meetingOn || lectureFormOpen || meetingSummaryBusy) return;
  // Start talking is still connecting. Wait, so two microphones do not open.
  if (!connected && talkBtn.disabled) return;
  summaryAloud = false;
  captureKind = kind === "lecture" ? "lecture" : "meeting";
  closeMeetingAfterClip = false;
  linesToSummarize = null;
  meetingSummaryBusy = false;
  meetingOn = true;
  captureEpoch += 1;
  meetingStartedAt = Date.now();
  meetingRecording = startMeetingRecording();
  meetingLines = [];
  capturePhotos = [];
  captureDir = "";
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
  const aloud = connected
    ? ""
    : " The summary stays on the screen, because Start talking is off.";
  const bubble = addBubble(captureRole(), `Listening. Arabic and English are written as they are said. I will stay quiet until you turn ${offWord} off.${aloud}`, false);
  bubble.querySelector(".who").textContent = offWord;
  // Load the listener that can write both languages before the first words arrive.
  fetch("/transcribe/warm", { method: "POST" }).catch(() => {});
  showMeetingStatus();
  syncCallButtons();
  if (!connected) startQuietMic();
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
  dirToSave = captureDir;
  captureDir = "";
  recordingToSave = finishMeetingRecording();
  closeMeetingAfterClip = true;
  stopSpeaking();
  setStatus(captureKind === "lecture"
    ? "Lecture off. Add the presenter and a title."
    : connected || summaryAloud
      ? "Meeting off. Writing the minutes…"
      : "Meeting off. Writing the minutes on the screen…");
  setCapsuleState("thinking");
  if (recordingClip) listenEpoch += 1;
  // The listening loop writes the summary after the last sentence is in.
  if (localEars || quietCapture) return;
  closeMeetingAfterClip = false;
  speakMeetingSummary();
}

meetingBtn.addEventListener("click", () => {
  if (meetingSummaryBusy || lectureFormOpen) return;
  if (!connected && !meetingOn && talkBtn.disabled) return;
  if (meetingOn && captureKind !== "lecture") endMeeting();
  else if (!meetingOn) beginMeeting("meeting");
});

lectureBtn.addEventListener("click", () => {
  if (meetingSummaryBusy || lectureFormOpen) return;
  if (!connected && !meetingOn && talkBtn.disabled) return;
  if (meetingOn && captureKind === "lecture") endMeeting();
  else if (!meetingOn) beginMeeting("lecture");
});

/**
 * Recap the meeting so far and suggest questions. Shown only, never spoken.
 * Reads a copy of the lines, so the minutes are written exactly as before.
 */
recapBtn.addEventListener("click", async () => {
  if (!meetingOn || recapBusy) return;
  // A new recap replaces the previous hold, so "Writing a recap…" can be seen.
  cancelRecapHold();
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
    // Land on the recap and keep the lecture from pulling the view away.
    if (lines.length) focusRecap(bubble);
  }
});

paintMeetingButton();

