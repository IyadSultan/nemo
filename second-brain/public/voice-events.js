/**
 * Hanging up, server events, tool calls, and the email, PDF, team and Outlook pieces of an answer.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

async function hangUp({ keepStatus = false, keepMeeting = false } = {}) {
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
  if (voiceBlocked) {
    voiceBlocked = "";
    fillVoices();
  }
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
  // A meeting that was already going stays on if Start talking never connected.
  if (!keepMeeting) {
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
    finishMeetingRecording();
    recordingToSave = null;
    captureKind = "";
    lectureFormOpen = false;
    meetingLines = [];
    closeMeetingAfterClip = false;
    linesToSummarize = null;
  }
  localEars = false;
  recordingClip = false;
  paintMeetingButton();
  muteBtn.disabled = !keepMeeting;
  muteBtn.classList.remove("is-muted");
  syncCallButtons();
  setCapsuleState(keepMeeting && meetingOn ? (muted ? "muted" : captureRole()) : "idle");
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
    if (window.brainPhoto?.open) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      if (text.trim() && window.brainPhoto.hear(text.trim())) return;
    }
    if (window.brainWord?.open) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      if (text.trim()) window.brainWord.hear(text.trim());
      return;
    }
    if (window.brainSlides?.open) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      if (text.trim()) window.brainSlides.hear(text.trim());
      return;
    }
    if (window.brainR?.open) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      if (text.trim()) window.brainR.hear(text.trim());
      return;
    }
    if (window.brainDeck?.open) {
      if (userPartialEl) {
        userPartialEl.remove();
        userPartialEl = null;
      }
      if (text.trim()) window.brainDeck.hear(text.trim());
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
    if (isCommandTableAsk(question)) {
      answerWithBrain(question);
      return;
    }
    if (selectedModel()?.hears) {
      lastQuestion = question;
      if (runCalendarAsk(question)) return;
      if (runTerminalAsk(question)) return;
      if (runFanAsk(question)) return;
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
  if (!["search_notes", "here_and_now", "app_manual", "sticky_notes"].includes(name) || !callId || handledCalls.has(callId)) return;
  handledCalls.add(callId);

  let output = "The tool failed.";
  try {
    if (name === "sticky_notes") {
      let request = "";
      try {
        request = JSON.parse(item.arguments || event.arguments || "{}").request || "";
      } catch (err) {
        console.error("Failed while reading the sticky-note request:", err);
      }
      setStatus("Updating sticky notes…");
      setCapsuleState("thinking");
      const response = await fetch("/stickies/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: request }),
      });
      const data = await response.json().catch(() => ({}));
      output = data.text || data.error || "I could not change the sticky notes.";
      window.brainStickies?.apply({ open: true });
    } else if (name === "here_and_now") {
      setStatus("Checking the time…");
      setCapsuleState("thinking");
      const response = await fetch("/here");
      const data = await response.json();
      output = data.text || output;
    } else if (name === "app_manual") {
      // What the app can do, and how one function works, comes from manual.md.
      setStatus("Checking the manual…");
      setCapsuleState("thinking");
      const response = await fetch("/manual");
      output = response.ok ? await response.text() : "The app manual is missing.";
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
    doc = document.createElement("div");
    doc.className = "skill-doc";
    bubble.append(doc);
  }
  renderMarkdown(doc, clean);
  followTranscript();
}

/** The PDF the server made, shown in the bubble with Save and Open buttons. */
/** The helper team under an answer: a small critter per helper, in its own colour, with its name. */
function showTeam(bubble, event) {
  bubble.querySelector(".team")?.remove();
  const row = document.createElement("div");
  row.className = "team";
  row.title = `Helpers on ${event.model || "Claude Sonnet"}`;
  for (const mate of event.agents) {
    const el = document.createElement("div");
    el.className = "mate";
    el.dataset.id = mate.id;
    el.dataset.state = "working";
    el.style.setProperty("--mate", mate.color || "#d97757");
    el.title = `${mate.name}: ${mate.task}`;
    // Click a helper to watch its progress in a terminal (terminal.js).
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", () => window.brainTerminal?.showAgent(el));
    el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && window.brainTerminal?.showAgent(el));
    el.innerHTML = `<svg class="mate-face" viewBox="20 0 560 470" aria-hidden="true"><g class="critter">
      <rect class="arm arm-l" x="35" y="140" width="52" height="105"/>
      <rect class="arm arm-r" x="513" y="140" width="52" height="105"/>
      ${[85, 180, 370, 465].map((x, i) => `<rect class="leg" style="--i:${i}" x="${x}" y="340" width="50" height="110"/>`).join("")}
      <rect class="body" x="85" y="35" width="430" height="310"/>
      <g class="eyes"><rect x="160" y="120" width="40" height="80"/><rect x="400" y="120" width="40" height="80"/></g>
    </g></svg><span class="mate-name"></span><span class="mate-doing"></span>`;
    el.querySelector(".mate-name").textContent = mate.name;
    el.querySelector(".mate-doing").textContent = "Starting";
    row.append(el);
  }
  bubble.querySelector(".who")?.after(row);
  followTranscript();
}

function updateTeamMate(bubble, event) {
  const el = bubble.querySelector(`.team .mate[data-id="${CSS.escape(event.id)}"]`);
  if (!el) return;
  if (event.state) el.dataset.state = event.state;
  if (event.doing) el.querySelector(".mate-doing").textContent = event.doing;
  if (event.log) window.brainTerminal?.agentLog(el, event.log);
}

function attachPdf(bubble, pdf) {
  if (!bubble || bubble.querySelector(".pdf-view")) return;
  const frame = document.createElement("iframe");
  frame.className = "pdf-view";
  frame.src = pdf.url;
  frame.title = pdf.name || "PDF";
  const row = document.createElement("div");
  row.className = "minutes-actions";
  const status = document.createElement("span");
  status.className = "minutes-saved";
  status.textContent = pdf.name || "";
  const button = (label, title, action) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ghost-btn small";
    el.textContent = label;
    el.title = title;
    el.addEventListener("click", () => action(el));
    return el;
  };
  const save = async (el, pick) => {
    const buttons = row.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    status.textContent = pick ? "Choose a folder…" : "Saving…";
    try {
      const response = await fetch(`/pdf/${encodeURIComponent(pdf.id)}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pick }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the PDF.");
      status.textContent = data.path ? `Saved: ${data.path}` : pdf.name || "";
      if (data.path) flashSaved();
    } catch (err) {
      console.error("Failed while saving the PDF:", err);
      status.textContent = err.message || "Could not save the PDF.";
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  row.append(
    button("Save", "Save in Downloads and show it in the Finder", (el) => save(el, false)),
    button("Save to…", "Choose a folder", (el) => save(el, true)),
    button("Open", "Open in Preview", () => {
      fetch(`/pdf/${encodeURIComponent(pdf.id)}/open`, { method: "POST" }).catch((err) => console.error("Failed while opening the PDF:", err));
    }),
    status,
  );
  bubble.append(frame, row);
  followTranscript();
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
  followTranscript();
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

