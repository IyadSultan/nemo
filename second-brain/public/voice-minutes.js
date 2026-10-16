/**
 * Minutes and lecture notes: summarizing a capture and saving it.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

/** Hand the transcript to a model that hears for itself, so it can summarize and remember it. */
function summarizeWithLiveModel() {
  const script = [
    "The meeting is over. Write the minutes, then say them.",
    "Keep Arabic and English as they were spoken. Do not translate.",
    "Cover what the meeting was about, the topics, any decisions, and who will do what.",
    "Do not invent facts that are not written here.",
    "After the minutes, answer questions about this meeting.",
    "",
    savedMeeting.slice(-12000),
  ].join("\n");
  if (gemini?.ready && gemini.ws?.readyState === WebSocket.OPEN) {
    gemini.ws.send(JSON.stringify({ realtimeInput: { text: script } }));
    setStatus("Writing the minutes…");
    setCapsuleState("thinking");
    return true;
  }
  if (selectedModel()?.hears && dc?.readyState === "open") {
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: script }],
      },
    });
    sendEvent({ type: "response.create" });
    setStatus("Writing the minutes…");
    setCapsuleState("thinking");
    return true;
  }
  return false;
}

/** Save the minutes or lecture notes as a Markdown file. With pick, macOS asks for the folder first. */
async function saveMinutes(meeting, pick, row, recording) {
  const buttons = row.querySelectorAll("button");
  const status = row.querySelector(".minutes-saved");
  const lecture = meeting.kind === "lecture";
  let folder = "";
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (pick) {
      const chosen = await fetch("/meeting/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: lecture ? "lecture" : "meeting" }),
      }).then((r) => r.json());
      folder = chosen.folder || "";
      if (!folder) return;
    }
    status.textContent = "Saving…";
    const response = await fetch(lecture ? "/lecture/save" : "/meeting/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...meeting, folder, model: modelSelect.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || (lecture ? "Could not save the lecture." : "Could not save the minutes."));
    if (data.path) meeting.captureDir = data.path.replace(/\/[^/]+$/, "");
    const shots = Number(data.photos) || 0;
    const extras = shots ? [shots === 1 ? "1 photo" : `${shots} photos`] : [];
    const audio = recording ? await recording : null;
    if (audio?.size) {
      status.textContent = `Saved: ${data.path}. Saving the recording…`;
      // Sent as raw bytes; the server saves it beside the notes as .m4a.
      const sent = await fetch("/recording", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Notes-Path": encodeURIComponent(data.path) },
        body: audio,
      });
      const kept = await sent.json().catch(() => ({}));
      extras.push(sent.ok ? `recording ${(kept.bytes / 1048576).toFixed(1)} MB` : "the recording could not be saved");
    }
    status.textContent = extras.length ? `Saved: ${data.path} (${extras.join(", ")})` : `Saved: ${data.path}`;
    flashSaved();
  } catch (err) {
    console.error(lecture ? "Failed while saving the lecture:" : "Failed while saving the minutes:", err);
    status.textContent = err.message || (lecture ? "Could not save the lecture." : "Could not save the minutes.");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

/** Two buttons under the notes: save to the usual folder, or pick another folder. */
function attachMinutesButtons(bubble, meeting) {
  const lecture = meeting.kind === "lecture";
  const row = document.createElement("div");
  row.className = "minutes-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost-btn small";
  save.textContent = lecture ? "Save lecture" : "Save minutes";
  save.title = lecture
    ? "Save in raw/lectures, in a folder named with the date and title"
    : "Save in raw/meetings, in a folder named with the date and title";
  const elsewhere = document.createElement("button");
  elsewhere.type = "button";
  elsewhere.className = "ghost-btn small";
  elsewhere.textContent = "Save to…";
  elsewhere.title = "Choose another folder";
  const status = document.createElement("span");
  status.className = "minutes-saved";
  const recording = recordingToSave;
  recordingToSave = null;
  save.addEventListener("click", () => saveMinutes(meeting, false, row, recording));
  elsewhere.addEventListener("click", () => saveMinutes(meeting, true, row, recording));
  row.append(save, elsewhere, status);
  bubble.append(row);
  meetingSaveRow = row;
}

/**
 * Ask who presented, suggest a title, and let the listener edit it.
 * Resolves with { presenter, title }, or null if they skip or the call ends.
 */
function askLectureDetails(notes) {
  const bubble = addBubble("lecture", "Who gave this talk? I will suggest a title you can change.", false);
  const form = document.createElement("form");
  form.className = "lecture-form";

  const presenterLabel = document.createElement("label");
  presenterLabel.append("Presenter");
  const presenterInput = document.createElement("input");
  presenterInput.type = "text";
  presenterInput.maxLength = 80;
  presenterInput.placeholder = "Name of the person speaking";
  presenterInput.autocomplete = "name";
  presenterLabel.append(presenterInput);

  const titleLabel = document.createElement("label");
  titleLabel.append("Title");
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.maxLength = 120;
  titleInput.placeholder = "Suggesting a title…";
  titleLabel.append(titleInput);

  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "minutes-actions";
  const write = document.createElement("button");
  write.type = "submit";
  write.className = "ghost-btn small";
  write.textContent = "Write summary";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "ghost-btn small";
  skip.textContent = "Not now";
  actions.append(write, skip);
  form.append(presenterLabel, titleLabel, error, actions);
  bubble.append(form);
  presenterInput.focus();

  // A title the listener already typed is kept when the suggestion arrives.
  let titleEdited = false;
  titleInput.addEventListener("input", () => { titleEdited = true; });
  fetch("/lecture/title", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: notes, model: modelSelect.value }),
  })
    .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || titleEdited || !data.title) {
        if (!titleInput.value) titleInput.placeholder = "Type a title";
        return;
      }
      titleInput.value = data.title;
    })
    .catch((err) => {
      console.error("Failed while suggesting a lecture title:", err);
      if (!titleInput.value) titleInput.placeholder = "Type a title";
    });

  return new Promise((resolve) => {
    settleLectureForm = (value) => {
      write.disabled = true;
      skip.disabled = true;
      presenterInput.disabled = true;
      titleInput.disabled = true;
      resolve(value);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const presenter = presenterInput.value.trim();
      const title = titleInput.value.trim();
      if (!presenter) {
        error.hidden = false;
        error.textContent = "Type the presenter's name.";
        presenterInput.focus();
        return;
      }
      error.hidden = true;
      closeLectureForm({ presenter, title });
    });
    skip.addEventListener("click", () => closeLectureForm(null));
  });
}

/** Write the talk summary, say it, and keep the exact words for later questions. */
async function summarizeLecture(lines, photos = [], savedDir = "") {
  savedMeeting = lines.join("\n");
  savedNotesKind = "lecture";
  lectureFormOpen = true;
  paintMeetingButton();
  setStatus("Lecture off. Type the presenter's name and edit the title, then press Write summary.");
  setCapsuleState(connected ? (muted ? "muted" : "listening") : "idle");
  const details = await askLectureDetails(savedMeeting);
  lectureFormOpen = false;
  if (!details) {
    if (photos.length) {
      meetingToSave = {
        lines: savedMeeting,
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
        minutes: savedMeeting,
        kind: "lecture",
        presenter: "",
        title: "Lecture",
        photos,
        captureDir: savedDir || dirToSave,
      };
      const note = addBubble("lecture", "The summary was skipped. The photos can still be saved.", false);
      attachMinutesButtons(note, meetingToSave);
    }
    setStatus(connected
      ? "Lecture off. The words are kept. Say Hey to ask about the talk."
      : "Lecture off. The words are kept.");
    if (connected && !localStop) setCapsuleState(muted ? "muted" : "listening");
    return;
  }
  meetingToSave = {
    lines: savedMeeting,
    startedAt: meetingStartedAt,
    endedAt: meetingEndedAt,
    minutes: "",
    kind: "lecture",
    presenter: details.presenter,
    title: details.title,
    photos,
    captureDir: savedDir || dirToSave,
  };
  const count = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const photoNote = photos.length === 1 ? " and 1 photo" : photos.length ? ` and ${photos.length} photos` : "";
  const note = addBubble("lecture", `Wrote down ${count}${photoNote}. Writing the talk summary now.`, false);
  attachMinutesButtons(note, meetingToSave);
  while (brainBusy) await sleep(40);
  if (meetingOn) return;
  paused = false;
  addBubble("user", "Write the summary of this talk.", false);
  await answerWithBrain("Write the summary of the talk that was just written down.", {
    summarizeLecture: true,
    presenter: details.presenter,
    title: details.title,
  });
}

/** Write the minutes, say them, and keep the exact words for later questions. */
async function speakMeetingSummary() {
  if (meetingSummaryBusy) return;
  const kind = captureKind;
  let lines = Array.isArray(linesToSummarize) ? linesToSummarize : meetingLines.slice();
  const photos = photosToSave.slice();
  photosToSave = [];
  const savedDir = dirToSave;
  dirToSave = "";
  linesToSummarize = null;
  meetingLines = [];
  if (!lines.length && (photos.length || savedDir)) {
    lines = [photos.length
      ? "A photo was taken. No words were written down."
      : "A document was added. No words were written down."];
  }
  if (!lines.length) {
    captureKind = "";
    paintMeetingButton();
    const name = kind === "lecture" ? "Lecture" : "Meeting";
    setStatus(connected ? `${name} off. I did not catch any words. Say Hey when you have a question.` : `${name} off. I did not catch any words.`);
    setCapsuleState(connected ? (muted ? "muted" : "listening") : "idle");
    summaryAloud = false;
    return;
  }
  if (kind === "lecture") {
    meetingSummaryBusy = true;
    syncCallButtons();
    try {
      await summarizeLecture(lines, photos, savedDir);
    } finally {
      meetingSummaryBusy = false;
      summaryAloud = false;
      lectureFormOpen = false;
      captureKind = "";
      syncCallButtons();
    }
    return;
  }
  captureKind = "";
  savedNotesKind = "";
  savedMeeting = lines.join("\n");
  const count = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const photoNote = photos.length === 1 ? " and 1 photo" : photos.length ? ` and ${photos.length} photos` : "";
  const note = addBubble("meeting", `Wrote down ${count}${photoNote}. Writing the minutes now.`, false);
  note.querySelector(".who").textContent = "Meeting";
  meetingToSave = { lines: savedMeeting, startedAt: meetingStartedAt, endedAt: meetingEndedAt, minutes: "", photos, captureDir: savedDir };
  attachMinutesButtons(note, meetingToSave);
  meetingSummaryBusy = true;
  syncCallButtons();
  try {
    if (summarizeWithLiveModel()) return;
    while (brainBusy) await sleep(40);
    if (meetingOn) return;
    paused = false;
    addBubble("user", "Write the minutes of this meeting.", false);
    await answerWithBrain("Write the minutes of the meeting that was just written down.", { summarizeMeeting: true });
  } finally {
    meetingSummaryBusy = false;
    summaryAloud = false;
    syncCallButtons();
  }
}

