/**
 * Answers written by the brain, and the chat bubbles they land in.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

// The question and the words written so far, so a steer can continue instead of starting over.
let liveQuestion = "";
let liveAnswer = "";
let steerQueued = null;
// Set when Hey cuts off an answer, so the next sentence can continue from it.
let cutSteer = null;

/**
 * While an answer is still being written: stop, make it shorter, instead …, or do … first.
 * Returns the follow-up, "stop", or "" when this sentence is not a steer.
 */
function steerIntent(question) {
  const q = String(question || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (/^(?:please |hey )?(?:stop|stop that|cancel that|never mind|nevermind)$/.test(q)) return "stop";
  if (/^(?:please |hey )?(?:make it shorter|make that shorter|shorter please|be shorter)$/.test(q)) return "Make the answer shorter. Keep the same facts.";
  const instead = q.match(/^(?:please |hey )?(?:instead|change that|do this instead) (.+)$/);
  if (instead) return instead[1];
  const first = q.match(/^(?:please |hey )?do (.+?) first$/);
  if (first) return `Do this first: ${first[1]}.`;
  return "";
}

/**
 * Stop the answer that is running. A follow-up starts again from the words already written.
 * Minutes and talk summaries are not steered (liveQuestion is empty while they are written).
 */
function steerWhileBusy(question) {
  const intent = steerIntent(question);
  if (!intent || !brainBusy || !liveQuestion) return false;
  const original = liveQuestion;
  const soFar = liveAnswer;
  // The same cut as Hey: the voice stops too, not only the writing.
  stopSpeaking();
  cancelAnswer = true;
  askAbort?.abort();
  try { activeReader?.cancel(); } catch { /* already finished */ }
  if (intent === "stop") {
    // "Make it shorter" and then "stop": the stop wins.
    steerQueued = null;
    addBubble("assistant", "Stopped.");
    setStatus(listenStatus());
    return true;
  }
  steerQueued = { question: intent, steerFrom: original, steerSoFar: soFar.slice(0, 1500) };
  return true;
}

/** Bonsai and GPT-6 write the answer. Voice control is what speaks it. */
async function answerWithBrain(question, extras) {
  const writingMinutes = Boolean(extras?.summarizeMeeting);
  const writingLecture = Boolean(extras?.summarizeLecture);
  const writingNotes = writingMinutes || writingLecture;
  // Start talking was not pressed: show the summary, and do not read it aloud.
  const quietNotes = writingNotes && !connected && !summaryAloud;
  await deskReady;
  // "/brain" still shows the table during a meeting. Other questions wait.
  const commandTable = isCommandTableAsk(question);
  if (brainBusy && !writingNotes && steerWhileBusy(question)) return;
  if (brainBusy || paused) return;
  if (!commandTable && (meetingOn || lectureFormOpen)) return;
  // "start a live presentation about …", "present it": deck.js opens the deck.
  if (!writingNotes && window.brainDeck?.command(question)) return;
  if (!writingNotes && window.brainWord?.command(question)) return;
  if (!writingNotes && window.brainSlides?.command(question)) return;
  if (!writingNotes && window.brainR?.command(question)) return;
  if (!writingNotes && window.brainPhoto?.ask(question)) return;
  if (!writingNotes && window.brainPhoto?.command(question)) return;
  if (!writingNotes && runStickiesAsk(question)) return;
  if (!writingNotes && runCalendarAsk(question)) return;
  if (!writingNotes && runTerminalAsk(question)) return;
  const tinyMove = writingNotes ? "" : playTinyMove(question);
  if (!connected) setBusy(true);
  compressAbort?.abort();
  compressGen += 1;
  lastQuestion = question;
  // A second steer still names the first question, not the steer before it.
  liveQuestion = writingNotes ? "" : extras?.steerFrom || question;
  liveAnswer = "";
  brainBusy = true;
  syncCallButtons();
  cancelAnswer = false;
  currentAnswerBubble = null;
  askAbort = new AbortController();
  if (micStream && !muted) watchWhileAnswering(micStream);
  setStatus(`Thinking with ${selectedModel()?.label || "the selected model"}…`);
  setCapsuleState("thinking");
  // Local models (Bonsai) always use the Kokoro voice on this Mac: free, no OpenAI.
  // A quiet summary never opens a voice, so nothing is read aloud.
  const macOnly = Boolean(selectedModel()?.local);
  const speakerReady = quietNotes || macOnly ? null : ensureSpeaker();
  if (!quietNotes) speakerReady?.catch(() => {});
  let speech = null;
  // Keep the beeps that started when they stopped talking. A typed question starts them now.
  armThinkCue();
  let bubble = null;
  let reader = null;
  let answer = "";
  let rawAnswer = "";
  let spokenShown = "";
  let outlook = null;
  let pdfMade = null;
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
        qaPdfs: writingNotes ? [] : window.brainPdfEdit?.qaIds() || [],
        tinyMove,
        skill: activeSkillId,
        model: modelSelect.value,
        reasoning: reasoningSelect.value,
        spoken: true,
        steerFrom: extras?.steerFrom || "",
        steerSoFar: extras?.steerSoFar || "",
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
            setStatus(`Speaking as ${voiceLabel()}…`);
            setCapsuleState("speaking");
          } catch (err) {
            if (!voiceBlocked) throw err;
            setStatus("OpenAI has no credits. Speaking with the voice on this Mac.");
          }
        }
        // OpenAI voice is out of credits, or this model lives on the Mac.
        // Kokoro speaks for free. If Kokoro cannot say a line, it uses the Mac voice.
        speech ??= (macOnly || voiceBlocked) ? kokoroVoice() : macVoice("Speaking with the Mac voice.");
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
        } else if (event.type === "team" && event.agents?.length) {
          // Claude Team: one small avatar per helper, with its name.
          bubble ??= addBubble("assistant", "", true);
          showTeam(bubble, event);
        } else if (event.type === "agent" && event.id) {
          if (bubble) updateTeamMate(bubble, event);
        } else if (event.type === "pdf" && event.url) {
          // The server printed a PDF. Show it under the spoken line, with Save and Open.
          pdfMade = event;
          bubble ??= addBubble("assistant", "", true);
          attachPdf(bubble, event);
        } else if (event.type === "deck" && event.id) {
          // The server saved a deck. Show its first slide with Present and PowerPoint buttons.
          bubble ??= addBubble("assistant", "", true);
          window.brainDeck?.attach(bubble, event);
        } else if (event.type === "skill") {
          // The server grabbed a skill, or put one away. One the brain chose
          // by itself (auto) is used for this answer only.
          if (!event.auto) setActiveSkill(event.id || "");
          skillLabel = event.name || "";
        } else if (event.type === "commands" && event.rows) {
          bubble ??= addBubble("assistant", "", true);
          currentAnswerBubble = bubble;
          mountCommandTable(bubble, event.rows);
        } else if (event.type === "delta") {
          rawAnswer += event.text || "";
          liveAnswer = rawAnswer;
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
          renderMarkdown(bubble.querySelector(".text"), spokenShown.trim());
          if (parts.kind === "skill" && parts.written) showSkillDoc(bubble, parts.written);
          followTranscript();
        } else if (event.type === "usage") addBrainUsage(event);
        else if (event.type === "ignored") {
          keepMemory = false;
          return;
        }
        else if (event.type === "error") throw new Error(event.message || "The selected model failed.");
      }
      if (!quietNotes) await speakReady(false);
    }

    if (cancelAnswer) {
      answer = rawAnswer.trim();
      return;
    }
    const finalParts = splitEmailDraft(rawAnswer, true);
    const spoken = finalParts.spoken.trim();
    const written = finalParts.written.trim();
    const leftover = spoken.startsWith(spokenShown.trim())
      ? spoken.slice(spokenShown.trim().length)
      : spoken.slice(spokenShown.length);
    if (leftover.trim()) unspoken += leftover;
    answer = written ? `${spoken}\n\n${written}` : spoken;
    if (pdfMade) answer = `${answer}\n\n(A PDF named ${pdfMade.name} was made and shown on the screen.)`.trim();
    if (!answer.trim()) throw new Error("The selected model returned an empty answer.");
    if (bubble) {
      bubble.classList.remove("partial");
      if (finalParts.kind === "skill") {
        renderMarkdown(bubble.querySelector(".text"), spoken || "The plan is on the screen.");
        if (skillLabel) bubble.querySelector(".who").textContent = skillLabel;
        showSkillDoc(bubble, written);
      } else {
        renderMarkdown(bubble.querySelector(".text"), spoken || written);
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
    if (!quietNotes) {
      await speakReady(true);
      speech?.end();
      await speech?.done;
    }
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
        ? "Listening. Say Hey, then your question. OpenAI has no credits, so the voice on this Mac spoke."
        : WAKE_STATUS);
    } else if (!connected && !localStop) {
      setCapsuleState("idle");
      setStatus(writingLecture
        ? (summaryAloud ? "The talk summary is written." : "The talk summary is on the screen.")
        : writingMinutes
        ? (summaryAloud ? "The minutes are written." : "The minutes are on the screen.")
        : "Type another question, or press Start talking.");
    }
  } catch (err) {
    speech?.stop();
    if (err?.name === "AbortError") {
      answer = rawAnswer.trim();
      return;
    }
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
    const next = steerQueued;
    steerQueued = null;
    if (next) {
      queueMicrotask(() => answerWithBrain(next.question, { steerFrom: next.steerFrom, steerSoFar: next.steerSoFar })
        .catch((err) => console.error("Failed while continuing a changed answer:", err)));
    }
    // Start talking is still connecting. Leave its button locked until that finishes.
    if (!connected && !summaryAloud) setBusy(false);
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

/** True while a recap should stay where it is, instead of jumping to the newest line. */
function userControlsScroll() {
  return pointerHoldingScroll || performance.now() < userScrollingUntil;
}

function recapStillHeld() {
  if (!recapPinned) return false;
  // The first 30 seconds always, and any time the user is still scrolling.
  return performance.now() < recapHoldUntil || userControlsScroll();
}

/**
 * Jump to the newest line.
 * Does nothing while a recap is held for reading.
 */
function followTranscript() {
  if (recapStillHeld()) return;
  if (recapPinned) {
    transcriptEl.querySelectorAll(".bubble.recap.is-held").forEach((el) => el.classList.remove("is-held"));
    recapPinned = false;
  }
  moveTranscriptTo(transcriptEl.scrollHeight);
}

/** Move the transcript. This move is not treated as the user scrolling. */
function moveTranscriptTo(top) {
  ignoreScrollUntil = performance.now() + 50;
  const previous = transcriptEl.style.scrollBehavior;
  // Jump in one step. A smooth slide here feels like the page will not sit still.
  transcriptEl.style.scrollBehavior = "auto";
  transcriptEl.scrollTop = top;
  transcriptEl.style.scrollBehavior = previous;
}

/**
 * Put the start of the recap at the top of the transcript and keep it there.
 * New lecture lines do not pull the view away for 30 seconds.
 * If the user scrolls, their place is kept until they stop.
 */
function focusRecap(bubble) {
  transcriptEl.querySelectorAll(".bubble.recap.is-held").forEach((el) => el.classList.remove("is-held"));
  bubble.classList.add("is-held");
  // The live lecture line grows. If it stays above the recap it pushes the
  // recap down the page. Park that line under the recap so the recap sits still.
  if (meetingPartialBubble && meetingPartialBubble !== bubble) bubble.after(meetingPartialBubble);
  recapPinned = true;
  recapHoldUntil = performance.now() + RECAP_HOLD_MS;
  userScrollingUntil = 0;
  clearTimeout(userScrollTimer);
  const bubbleTop = bubble.getBoundingClientRect().top;
  const panelTop = transcriptEl.getBoundingClientRect().top;
  // A small gap so the "Recap" label is not flush against the top edge.
  moveTranscriptTo(Math.max(0, transcriptEl.scrollTop + (bubbleTop - panelTop) - 12));
  clearTimeout(recapHoldTimer);
  recapHoldTimer = setTimeout(releaseRecapIfIdle, RECAP_HOLD_MS);
  setStatus("Recap is held on screen for 30 seconds. It also stays while you are scrolling.");
}

/** Drop the hold once the 30 seconds are over and the user has stopped scrolling. */
function releaseRecapIfIdle() {
  if (!recapPinned) return;
  if (performance.now() < recapHoldUntil || userControlsScroll()) return;
  transcriptEl.querySelectorAll(".bubble.recap.is-held").forEach((el) => el.classList.remove("is-held"));
  recapPinned = false;
  followTranscript();
  if (meetingOn) {
    setStatus(captureKind === "lecture"
      ? "Lecture. I am writing the words as they are said, in Arabic or English."
      : MEETING_STATUS);
  }
}

/** Forget a recap hold, for a cleared transcript or a new recap. */
function cancelRecapHold() {
  recapPinned = false;
  recapHoldUntil = 0;
  userScrollingUntil = 0;
  clearTimeout(recapHoldTimer);
  clearTimeout(userScrollTimer);
  transcriptEl.querySelectorAll(".bubble.recap.is-held").forEach((el) => el.classList.remove("is-held"));
}

/** The user moved the transcript. Keep their place until they let go. */
function noteUserScroll() {
  if (performance.now() < ignoreScrollUntil) return;
  userScrollingUntil = performance.now() + USER_SCROLL_MS;
  if (!recapPinned) return;
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(releaseRecapIfIdle, USER_SCROLL_MS);
}

transcriptEl.addEventListener("scroll", noteUserScroll, { passive: true });
transcriptEl.addEventListener("wheel", () => {
  // A wheel tick means the user has the scroll, even before the position changes.
  ignoreScrollUntil = 0;
  noteUserScroll();
}, { passive: true });
transcriptEl.addEventListener("touchmove", () => {
  ignoreScrollUntil = 0;
  noteUserScroll();
}, { passive: true });
transcriptEl.addEventListener("pointerdown", () => {
  // Grabbing the scrollbar, or touching the list, counts as the user controlling it.
  ignoreScrollUntil = 0;
  pointerHoldingScroll = true;
});
window.addEventListener("pointerup", endPointerScroll);
window.addEventListener("pointercancel", endPointerScroll);

function endPointerScroll() {
  if (!pointerHoldingScroll) return;
  pointerHoldingScroll = false;
  if (!recapPinned) return;
  userScrollingUntil = performance.now() + USER_SCROLL_MS;
  clearTimeout(userScrollTimer);
  userScrollTimer = setTimeout(releaseRecapIfIdle, USER_SCROLL_MS);
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
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  bubble.append(who, body);
  transcriptEl.appendChild(bubble);
  followTranscript();
  return bubble;
}

function appendAssistantPartial(delta) {
  if (!assistantPartialEl) assistantPartialEl = addBubble("assistant", "", true);
  assistantPartialEl.querySelector(".text").textContent += delta;
  followTranscript();
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
  followTranscript();
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

// The reading bubble for a session, so the summary can replace "Reading what it did…".
const agentVisits = new Map();

/** The same Claude critter as the big one, drawn small beside a chat line. */
function miniClaude() {
  const holder = document.createElement("div");
  holder.innerHTML = `<svg class="mini-claude" viewBox="20 0 560 470" aria-hidden="true"><g class="critter">
      <rect class="arm arm-l" x="35" y="140" width="52" height="105"/>
      <rect class="arm arm-r" x="513" y="140" width="52" height="105"/>
      ${[85, 180, 370, 465].map((x, i) =>
        `<rect class="leg" style="--i:${i}" x="${x}" y="340" width="50" height="110"/>`).join("")}
      <rect class="body" x="85" y="35" width="430" height="310"/>
      <g class="eyes">
        <rect x="160" y="120" width="40" height="80"/>
        <rect x="400" y="120" width="40" height="80"/>
      </g>
      <rect class="mouth" x="270" y="235" width="60" height="40"/>
    </g></svg>`;
  return holder.firstElementChild;
}

/**
 * A Claude session in some Terminal.
 * phase "start" is the prompt. "reading" waits for the brain. "done" is the summary.
 */
function rememberAgentPlace(bubble, data) {
  if (data.cwd) bubble.dataset.cwd = String(data.cwd);
  if (data.name) bubble.dataset.name = String(data.name);
  if (data.place) bubble.dataset.place = String(data.place);
  if (data.session) bubble.dataset.session = String(data.session);
}

/**
 * Exit and Wake are for a Claude in the Terminal.
 * Exit shows while that Claude is still running. Wake shows after it has quit.
 * A Cursor agent (Grok and the others) does not get these buttons.
 */
function setAgentPower(bubble, action) {
  if ((bubble.dataset.place || "terminal") === "cursor") {
    bubble.querySelector(".agent-power")?.remove();
    return;
  }
  let button = bubble.querySelector(".agent-power");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "agent-power";
    button.addEventListener("click", () => runAgentPower(bubble));
    bubble.querySelector(".agent-copy")?.append(button);
  }
  const wake = action === "wake";
  button.dataset.action = wake ? "wake" : "exit";
  button.textContent = wake ? "Wake" : "Exit";
  button.title = wake
    ? "Start Claude again in this folder, with the last chat remembered"
    : "Quit this Claude and keep the chat";
  button.setAttribute("aria-label", wake ? `Wake ${bubble.dataset.name || "Claude"}` : `Exit ${bubble.dataset.name || "Claude"}`);
  button.disabled = false;
}

function agentPayload(bubble) {
  return {
    cwd: bubble.dataset.cwd || "",
    name: bubble.dataset.name || "",
    place: bubble.dataset.place || "terminal",
    session: bubble.dataset.session || "",
  };
}

/** Ask the server if this Claude is still running, then show Exit or Wake. */
async function refreshAgentPower(bubble, allowWake) {
  if (!bubble.isConnected) return;
  if ((bubble.dataset.place || "terminal") === "cursor") return;
  try {
    const response = await fetch("/agents/alive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentPayload(bubble)),
    });
    const data = await response.json();
    if (!response.ok || !bubble.isConnected) return;
    if (data.awake) setAgentPower(bubble, "exit");
    else if (allowWake || bubble.classList.contains("done")) setAgentPower(bubble, "wake");
  } catch (err) {
    console.error("Failed while checking if a Claude is awake:", err);
  }
}

function bubblesForSession(session) {
  if (!session) return [];
  return [...transcriptEl.querySelectorAll(".bubble.agent")].filter((bubble) => bubble.dataset.session === session);
}

/** Exit quits a running Claude. Wake runs claude --continue so the old chat comes back. */
async function runAgentPower(bubble) {
  const button = bubble.querySelector(".agent-power");
  const action = button?.dataset.action === "wake" ? "wake" : "exit";
  const name = bubble.dataset.name || "Claude";
  if (button) button.disabled = true;
  setStatus(action === "wake" ? `Waking ${name}…` : `Exiting ${name}…`);
  try {
    const response = await fetch(action === "wake" ? "/agents/wake" : "/agents/exit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentPayload(bubble)),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const gone = data.asleep || /already be closed|already asleep/.test(String(data.error || ""));
      if (gone) setAgentPower(bubble, "wake");
      else if (data.awake) setAgentPower(bubble, "exit");
      else if (button) button.disabled = false;
      setStatus(data.error || (action === "wake" ? "I could not wake that Claude." : "I could not exit that Claude."));
      return;
    }
    if (action === "wake") {
      setAgentPower(bubble, "exit");
      setStatus(`Woke ${name}. The last chat is coming back.`);
      return;
    }
    setAgentPower(bubble, "wake");
    setStatus(`Told ${name} to exit.`);
  } catch (err) {
    console.error("Failed while using Exit or Wake:", err);
    setStatus(action === "wake" ? "I could not wake that Claude." : "I could not exit that Claude.");
    if (button) button.disabled = false;
  }
}

/** Cursor agents (Grok and the others) open in Cursor. Claude Code opens in Terminal. */
function labelAgentButton(button, name, place) {
  const inCursor = place === "cursor";
  button.title = inCursor ? "Open this agent in Cursor" : "Open this Terminal";
  button.setAttribute("aria-label", inCursor ? `Open ${name} in Cursor` : `Open the Terminal for ${name}`);
}

function agentHeading(name, phase, place) {
  const where = place === "cursor" ? " · Cursor" : "";
  if (phase === "start") return `${name}${where} · working`;
  if (phase === "reading") return `${name}${where} · reading`;
  return `${name}${where} · finished`;
}

/**
 * Every post from one agent sits in one stack, even when another agent
 * spoke in between. Only the newest post shows until you press + Expand.
 */
function agentKey(bubble) {
  return bubble.dataset.name || "Claude";
}

function agentGroupOf(bubble) {
  const parent = bubble.parentElement;
  return parent?.classList.contains("agent-group") ? parent : null;
}

function makeAgentGroup(firstBubble) {
  const group = document.createElement("div");
  group.className = "agent-group is-collapsed";
  group.dataset.name = agentKey(firstBubble);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "agent-expand";
  toggle.addEventListener("click", () => {
    group.classList.toggle("is-collapsed");
    refreshAgentGroup(group);
  });
  firstBubble.before(group);
  group.append(firstBubble, toggle);
  return group;
}

/**
 * Put this post on the one card for this agent.
 * Older posts are pulled in even when another agent sits between them.
 * The card moves to the bottom, so the newest post stays in view.
 */
function placeAgentBubble(bubble) {
  const name = agentKey(bubble);
  const existing = [...transcriptEl.querySelectorAll(".bubble.agent")].filter(
    (item) => item !== bubble && agentKey(item) === name,
  );
  if (!existing.length) {
    transcriptEl.appendChild(bubble);
    return;
  }
  let group = agentGroupOf(existing[0]);
  if (!group) group = makeAgentGroup(existing[0]);
  const toggle = group.querySelector(".agent-expand");
  for (const item of existing) {
    if (item.parentElement !== group) toggle.before(item);
  }
  for (const other of [...transcriptEl.querySelectorAll(".agent-group")]) {
    if (other !== group && other.dataset.name === name) other.remove();
  }
  toggle.before(bubble);
  transcriptEl.appendChild(group);
  refreshAgentGroup(group);
}

/** How many older posts are tucked away while the stack is folded. */
function refreshAgentGroup(group) {
  const bubbles = [...group.querySelectorAll(":scope > .bubble.agent")];
  const toggle = group.querySelector(".agent-expand");
  const hidden = Math.max(0, bubbles.length - 1);
  const name = group.dataset.name || "this agent";
  if (hidden < 1) {
    toggle.hidden = true;
    group.classList.remove("is-collapsed");
    return;
  }
  toggle.hidden = false;
  const open = !group.classList.contains("is-collapsed");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    toggle.textContent = "– Collapse";
    toggle.title = `Hide the earlier messages from ${name}`;
    toggle.setAttribute("aria-label", `Collapse earlier messages from ${name}`);
    return;
  }
  const count = hidden === 1 ? "1 earlier message" : `${hidden} earlier messages`;
  toggle.textContent = hidden === 1 ? "+ Expand" : `+ Expand (${hidden})`;
  toggle.title = `Show ${count} from ${name}`;
  toggle.setAttribute("aria-label", `Expand ${count} from ${name}`);
}

/**
 * A finished summary should be the post you see.
 * If it updated an older card that was folded away, move that card to the end
 * of the stack so it is the one still showing.
 */
function showFinishedInGroup(bubble) {
  const group = agentGroupOf(bubble);
  if (!group) {
    transcriptEl.appendChild(bubble);
    return;
  }
  const toggle = group.querySelector(".agent-expand");
  if (group.classList.contains("is-collapsed") && toggle && bubble.nextElementSibling !== toggle) {
    toggle.before(bubble);
  }
  transcriptEl.appendChild(group);
  refreshAgentGroup(group);
}

/** Clicking the little Claude opens the Terminal (or Cursor) where that agent is. */
async function openAgentTerminal(bubble) {
  const name = bubble.dataset.name || "Claude";
  setStatus(`Opening ${name}…`);
  try {
    const response = await fetch("/agents/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: bubble.dataset.cwd || "",
        name,
        place: bubble.dataset.place || "terminal",
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error || "I could not find that Terminal.");
      return;
    }
    setStatus(data.where === "Cursor" ? `Opened ${name} in Cursor.` : `Opened ${name} in Terminal.`);
  } catch (err) {
    console.error("Failed while opening an agent's Terminal:", err);
    setStatus("I could not open that Terminal.");
  }
}

/**
 * Say the finished line out loud, like "ipolicies finished. It built the wiki."
 * Kokoro on this Mac reads it, so it costs nothing; the Mac voice is the fallback.
 * One at a time, after the brain stops talking. Quiet while a meeting or lecture is written down.
 */
let agentSpeech = Promise.resolve();
function sayAgentDone(name, text, bubble) {
  const line = forSpeech(`${name} finished. ${String(text || "").replace(/\[REDACTED-DIGITS\]/g, "a number")}`);
  agentSpeech = agentSpeech.then(async () => {
    while (brainBusy) await sleep(200);
    if (meetingOn || !bubble?.isConnected) return;
    // The mouth stays open and shut for the whole spoken line.
    // On a folded card, the face you can see is the one that talks.
    const group = bubble.closest(".agent-group");
    bubble.classList.add("is-talking");
    group?.classList.add("is-talking");
    try {
      const response = await fetch("/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, voice: localStorage.getItem("voice:kokoro") || "af_heart" }),
      });
      if (!response.ok) throw new Error(`Kokoro returned ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      try {
        await new Promise((resolve) => {
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch(resolve);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed while speaking an agent's summary with Kokoro, using the Mac voice:", err);
      await new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(line);
        utterance.onend = resolve;
        utterance.onerror = resolve;
        speechSynthesis.speak(utterance);
      });
    } finally {
      bubble.classList.remove("is-talking");
      group?.classList.remove("is-talking");
    }
  }).catch((err) => console.error("Failed while speaking an agent's summary:", err));
}

function showAgentVisit(data) {
  const phase = data.phase === "done" ? "done" : data.phase === "reading" ? "reading" : "start";
  const name = String(data.name || "Claude");
  const session = String(data.session || "");
  const text = String(data.text || "");
  if (phase === "done" && session && agentVisits.has(session)) {
    const bubble = agentVisits.get(session);
    agentVisits.delete(session);
    rememberAgentPlace(bubble, data);
    bubble.classList.remove("working");
    bubble.classList.add("done");
    const who = bubble.querySelector(".who");
    if (who) who.textContent = agentHeading(name, "done", bubble.dataset.place || "");
    labelAgentButton(bubble.querySelector(".mini-claude-btn"), name, bubble.dataset.place || "");
    renderMarkdown(bubble.querySelector(".text"), text);
    setAgentPower(bubble, "wake");
    refreshAgentPower(bubble);
    showFinishedInGroup(bubble);
    for (const other of bubblesForSession(session)) {
      if (other === bubble) continue;
      refreshAgentPower(other, true);
    }
    followTranscript();
    sayAgentDone(name, text, bubble);
    return;
  }
  clearEmptyHint();
  const bubble = document.createElement("article");
  bubble.className = `bubble agent ${phase === "done" ? "done" : "working"}`;
  rememberAgentPlace(bubble, data);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini-claude-btn";
  labelAgentButton(button, name, bubble.dataset.place || "");
  button.append(miniClaude());
  button.addEventListener("click", () => openAgentTerminal(bubble));
  const copy = document.createElement("div");
  copy.className = "agent-copy";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = agentHeading(name, phase, bubble.dataset.place || "");
  const body = document.createElement("div");
  body.className = "text";
  // The finished summary is Claude's own words, often with lists and bold. The prompt stays plain.
  if (phase === "done") renderMarkdown(body, text);
  else body.textContent = text;
  copy.append(who, body);
  bubble.append(button, copy);
  placeAgentBubble(bubble);
  if (phase === "done") setAgentPower(bubble, "wake");
  else setAgentPower(bubble, "exit");
  refreshAgentPower(bubble);
  if (phase === "reading" && session) agentVisits.set(session, bubble);
  followTranscript();
  if (phase === "done") sayAgentDone(name, text, bubble);
}

// The server sends these when a Claude in a Terminal starts or finishes.
control.addEventListener("agent", (event) => {
  let data = {};
  try {
    data = JSON.parse(event.data || "{}");
  } catch (err) {
    console.error("Failed while reading an agent visit:", err);
    return;
  }
  showAgentVisit(data);
});
