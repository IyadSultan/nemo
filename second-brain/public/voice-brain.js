/**
 * Answers written by the brain, and the chat bubbles they land in.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

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
  if (brainBusy || paused) return;
  if (!commandTable && (meetingOn || lectureFormOpen)) return;
  // "start a live presentation about …", "present it": deck.js opens the deck.
  if (!writingNotes && window.brainDeck?.command(question)) return;
  if (!writingNotes && window.brainWord?.command(question)) return;
  if (!writingNotes && window.brainSlides?.command(question)) return;
  if (!writingNotes && runTerminalAsk(question)) return;
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

    if (cancelAnswer) return;
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
        ? "Listening. Say Hey, then your question. Voice control has no credits, so the Mac voice spoke."
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
  const body = document.createElement("p");
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
