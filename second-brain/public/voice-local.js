/**
 * The Mac listens for Bonsai and GPT-6, which cannot hear.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

/**
 * Bonsai and GPT-6: the Mac listens, that model writes, voice control speaks.
 */
async function startLocalListen() {
  localStop = false;
  localEars = true;
  micStream = await openMic();
  connected = true;
  voiceSelect.disabled = true;
  modelSelect.disabled = true;
  reasoningSelect.disabled = true;
  muteBtn.disabled = false;
  syncCallButtons();
  talkBtn.setAttribute("aria-pressed", "true");
  talkLabel.textContent = "End call";
  const macOnly = Boolean(selectedModel()?.local);
  setStatus(listenStatus());
  setCapsuleState("listening");
  setBusy(false);
  warmJudge();
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
    if (closeMeetingAfterClip && !meetingOn && !recordingClip) {
      closeMeetingAfterClip = false;
      await speakMeetingSummary();
      continue;
    }
    if (queuedQuestion) {
      const question = queuedQuestion;
      queuedQuestion = "";
      if (meetingOn) {
        addMeetingLine(question);
        continue;
      }
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
    if (meetingOn) {
      showMeetingStatus();
      const heard = await captureMeetingLine(micStream);
      if (!connected || localStop) {
        closeMeetingAfterClip = false;
        break;
      }
      const list = closeMeetingAfterClip && !meetingOn && Array.isArray(linesToSummarize)
        ? linesToSummarize
        : meetingLines;
      freezeMeetingDraft(heard, list);
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
        continue;
      }
      showMeetingStatus();
      continue;
    }
    setStatus(listenStatus());
    setCapsuleState("listening");
    const clip = await recordUntilSilence(micStream);
    if (!connected || localStop) {
      clearThinkCue();
      closeMeetingAfterClip = false;
      break;
    }
    if (paused) {
      clearThinkCue();
      continue;
    }
    if (!clip || clip.size < 2000) {
      clearThinkCue();
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
      }
      continue;
    }

    setStatus(meetingOn ? `Writing down the ${captureKind === "lecture" ? "lecture" : "meeting"}…` : "Writing down what you said…");
    setCapsuleState("thinking");
    let text = "";
    try {
      text = await transcribeClip(clip);
    } catch (err) {
      console.error("Failed while transcribing locally:", err);
      clearThinkCue();
      if (closeMeetingAfterClip && !meetingOn) {
        closeMeetingAfterClip = false;
        await speakMeetingSummary();
        continue;
      }
      setStatus(err.message || "The local voice model could not hear that.");
      await sleep(600);
      continue;
    }
    if (closeMeetingAfterClip && !meetingOn) {
      closeMeetingAfterClip = false;
      const line = String(text || "").trim();
      if (line && !looksLikeSilence(line) && Array.isArray(linesToSummarize) && linesToSummarize.at(-1) !== line) {
        linesToSummarize.push(line);
        const bubble = addBubble(captureRole(), line, false);
        bubble.querySelector(".who").textContent = captureName();
      }
      await speakMeetingSummary();
      continue;
    }
    if (meetingOn) {
      clearThinkCue();
      addMeetingLine(text);
      showMeetingStatus();
      continue;
    }
    // The Word editor is open: "Hey, …" goes to it.
    if (window.brainWord?.open) {
      clearThinkCue();
      if (!looksLikeSilence(text)) window.brainWord.hear(text);
      setCapsuleState("listening");
      continue;
    }
    // The slides editor is open: "Hey, …" goes to it.
    if (window.brainSlides?.open) {
      clearThinkCue();
      if (!looksLikeSilence(text)) window.brainSlides.hear(text);
      setCapsuleState("listening");
      continue;
    }
    // A deck is on screen: what is said goes to it (next slide, or a new slide in live mode), no Hey needed.
    if (window.brainDeck?.open) {
      clearThinkCue();
      if (!looksLikeSilence(text)) window.brainDeck.hear(text);
      setCapsuleState("listening");
      continue;
    }
    if (looksLikeSilence(text)) {
      clearThinkCue();
      setStatus(listenStatus());
      setCapsuleState("listening");
      continue;
    }
    // Two whispers: show both lines before anything else happens to the words.
    if (earsSelect.value === "whisper-both") {
      const heard = addBubble("note", text, false);
      heard.querySelector(".who").textContent = "Heard";
    }
    if (medicalListening()) {
      const cleaned = await medicalTurn({ text, at: performance.now() });
      if (!cleaned || !connected || localStop) continue;
      if (cleaned.english && cleaned.english !== cleaned.question) showMedicalNote(cleaned.english);
      if (!cleaned.question) continue;
      addBubble("user", cleaned.question, false);
      await answerWithBrain(cleaned.question);
      continue;
    }
    let question = questionFromHeard(text);
    if (keyboardWake) {
      // The key already said this sentence is for the brain. Hey is optional.
      if (!question) {
        const fromKey = wordsFromKey(text);
        if (fromKey) question = fromKey;
      }
      if (question) keyboardWake = false;
      else {
        clearThinkCue();
        setStatus(KEY_WAKE_STATUS);
        setCapsuleState("listening");
        continue;
      }
    } else if (!question && jevListening()) {
      question = await jevQuestion({ text, at: performance.now() });
    }
    // No wake phrase, or only the phrase with no question: stay quiet.
    if (!question) {
      clearThinkCue();
      setStatus(listenStatus());
      setCapsuleState("listening");
      continue;
    }
    addBubble("user", question, false);
    await answerWithBrain(question);
  }
  localEars = false;
}

