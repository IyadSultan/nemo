/**
 * Second brain — ask your wiki, get a short answer fast.
 *
 * What this file does, in plain words:
 * 1. On startup it reads the markdown notes in your OneDrive wiki.
 *    The notes stay in OneDrive. Nothing is copied into this git repo.
 * 2. When you ask a question, it searches those notes on your Mac
 *    and keeps only the few pages that match.
 * 3. It sends just those pages to the GPT-6 model you picked and
 *    streams the answer back to the browser.
 * 4. When OpenAI reports how many tokens it used, this server
 *    multiplies those tokens by that model's price.
 *
 * The default is GPT-OSS 20B on this Mac with thinking off: free and fast.
 * You can switch model and reasoning on the page. A higher reasoning
 * level does not change the price per token. It spends more thinking
 * tokens, and those are billed at the output price.
 */

import { DEFAULT_MODEL, DEFAULT_REASONING, MEMORY_MODEL, OLLAMA_URL, PORT, WIKI_PATH, __dirname } from "./config.js";
import { appendDayLog, dayKey, saveConversation, summarizeDay } from "./brain.js";
import { parseMeeting, spokenCalendar, spokenMeetingWaiting } from "./calendar.js";
import { controlClients, registerControl, sendControl } from "./control.js";
import * as desk from "./desk.js";
import { checkWatches, deliverReminders, registerDeskjobs, runDeskCommand, syncSuggestions } from "./deskjobs.js";
import { emailSearchJob, runEmailSearch } from "./emailsearch.js";
import { readSavedFolders, refreshBrainNotes, registerFolders, reloadNotes } from "./folders.js";
import { imessageHandle, registerIMessage, runTextMe, sendIMessage, textMeJob } from "./imessage.js";
import { asksForOutlookCalendar, calendarRead, isChatQuestion, isNoise, meetingJob, memoJob, wantsEmail } from "./intents.js";
import { judgeSpeech, warmJudge } from "./jev.js";
import { learningJob, siteShortcut } from "./learnings.js";
import { registerLive } from "./live.js";
import { cleanMailAddress, findRawEmails, indexRawMail, polishReply, replyWithOriginal } from "./mail.js";
import { cleanMedical, warmMedgem } from "./medgem.js";
import { cleanMeetingNotes, lectureSummaryPrompt, meetingSummaryPrompt, oneLine, photoDataUrl, registerMeetings } from "./meetings.js";
import { lectureFolder, meetingFolder, memoFolder, memosForPrompt, runMemoryJob, spokenSavedMemo } from "./memos.js";
import { askModelOnce, clientError, finishPdf, ollamaNamesMatch, replyNow, safeJson, stopAllOllamaModels, stopOllamaModel, streamAnswer, streamClaudeAnswer, streamLocalAnswer, writeEvent } from "./models.js";
import { excerpt, notesForQuestion, parseNote, semantic } from "./notes.js";
import { findOnMacJob, openFileJob, runFindOnMac, runOpenFile } from "./openfile.js";
import { openOutlookDraft } from "./outlook.js";
import { registerDeck, rememberDocument } from "./deck.js";
import { pdfCatcher, registerPdf } from "./pdf.js";
import { answerPdfTool, qaBlock, registerPdfTools, rememberPdf, wantsPdfTool } from "./pdftools.js";
import { ingestDocument } from "./upload.js";
import { MODELS, REASONING_LEVELS, VOICE_MODELS, getModel } from "./pricing.js";
import { TINY_LINES, buildPrompt, cleanHistory, cleanMemory } from "./prompt.js";
import { runCommand } from "./shell.js";
import { listSkills, matchSkill, mentionsSkillStop, registerSkills, replySkillStop, skillInstructions } from "./skills.js";
import { registerSpeech, startKokoro, startWhisperServer } from "./speech.js";
import { hereAndNow } from "./spoken.js";
import { loadedLocalId, notes, rawMail, selected, setLoadedLocalId, setNotes } from "./state.js";
import { searchWeb, shouldBrowse, showSiteJob } from "./web.js";
import express from "express";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }));
// deny: hidden files (the session log under public/.claude) are not sent to the browser.
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
// Rive runtime for the Tiny mascot (served from node_modules, no CDN).
app.use("/vendor/rive", express.static(path.join(__dirname, "..", "node_modules", "@rive-app", "canvas"), { dotfiles: "deny" }));

/** Recent questions and answers, so "open the one we discussed" can find that file. */
function fileTalk(history) {
  const saved = desk.savedChat();
  const bits = [saved.summary];
  for (const turn of saved.turns || []) bits.push(turn.question, turn.answer);
  for (const turn of history || []) bits.push(turn.question, turn.answer);
  return bits.filter(Boolean).join("\n");
}

app.get("/health", (_req, res) => {
  // Note count and the default model only. Folder paths stay on /folders, which the page already asks for.
  res.json({
    ok: true,
    notes: notes.length,
    defaultModel: DEFAULT_MODEL,
    defaultReasoning: DEFAULT_REASONING,
  });
});

app.get("/here", (_req, res) => {
  res.json({ text: hereAndNow() });
});

app.get("/models", (_req, res) => {
  res.json({ models: [...VOICE_MODELS, ...MODELS], reasoning: REASONING_LEVELS });
});

registerFolders(app);
registerSpeech(app);

app.get("/notes", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.json({ notes: "No question to search." });
  const hits = await notesForQuestion(query, 5);
  if (!hits.length) return res.json({ notes: "No matching notes." });
  const notesText = hits
    .map((hit) => {
      const body = hit.override || excerpt(hit.note.text, hit.terms, 1200);
      return `Note: ${hit.note.title}\nFile: ${hit.note.rel}\n${body}`;
    })
    .join("\n\n---\n\n");
  res.json({ notes: notesText });
});

/**
 * Medical speech (medgem.js). GPT-OSS 20B on this Mac turns a transcript into
 * English medical words with identifiers removed. It does not answer.
 * A question, when there is one, is forwarded to the brain by the page.
 */
registerLive(app);
registerControl(app);

app.post("/medgem/warm", (_req, res) => {
  warmMedgem().catch((err) => console.error("Failed while loading GPT-OSS:", err?.message || err));
  res.json({ ok: true });
});

app.post("/medgem/clean", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
  if (!text) return res.status(400).json({ error: "No words to clean." });
  try {
    res.json(await cleanMedical(text));
  } catch (err) {
    console.error("Failed while cleaning medical speech:", err?.message || err);
    res.status(502).json({ error: "GPT-OSS could not clean that." });
  }
});

/** Jev listening: is this heard sentence meant for the second brain? (jev.js) */
app.post("/jev/warm", (_req, res) => {
  warmJudge().catch((err) => console.error("Failed while loading the judge model:", err?.message || err));
  res.json({ ok: true });
});

app.post("/jev/judge", async (req, res) => {
  const latest = typeof req.body?.latest === "string" ? req.body.latest.trim().slice(0, 1000) : "";
  if (!latest) return res.status(400).json({ error: "No words to judge." });
  try {
    res.json(await judgeSpeech({
      latest,
      earlier: Array.isArray(req.body.earlier) ? req.body.earlier.filter((t) => typeof t === "string").map((t) => t.slice(0, 300)) : [],
      lastAnswer: typeof req.body.lastAnswer === "string" ? req.body.lastAnswer : "",
      justAnswered: Boolean(req.body.justAnswered),
      backend: ["gemma", "typesafe"].includes(req.body.backend) ? req.body.backend : undefined,
    }));
  } catch (err) {
    console.error("Failed while asking Jev:", err?.message || err);
    res.status(502).json({ error: "Jev could not judge that sentence." });
  }
});

app.post("/stop-models", async (_req, res) => {
  try {
    res.json(await stopAllOllamaModels());
  } catch (err) {
    console.error("Failed while stopping local models:", err?.message || err);
    res.status(502).json({ error: clientError(err?.message, "Could not stop the local models.") });
  }
});

app.post("/stop-model", async (req, res) => {
  const id = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const model = getModel(id);
  if (!model?.local) return res.json({ stopped: false, wasLoaded: false });
  try {
    const result = await stopOllamaModel(model.id);
    res.json({ ...result, label: model.label });
  } catch (err) {
    console.error("Failed while stopping a local model:", err?.message || err);
    res.status(502).json({ error: clientError(err?.message, "Could not stop the previous model.") });
  }
});

app.post("/compress", async (req, res) => {
  const history = cleanHistory(req.body?.history);
  const prior = cleanMemory(req.body?.memory);
  if (!history.length && !prior) return res.json({ memory: "" });

  const model = getModel(MEMORY_MODEL);
  const source = [
    prior ? `Older memory:\n${prior}` : "",
    ...history.map((turn) => `User asked: ${turn.question}\nAnswered: ${turn.answer}`),
  ].filter(Boolean).join("\n\n");

  try {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content: [
              "Compress this voice chat into a short memory for the next question.",
              "Keep every user question in the user's exact words, each on its own line starting with User asked:",
              "After each question, write one short sentence starting with Answered:",
              "Put the newest question last. Do not add anything that was not said.",
            ].join(" "),
          },
          { role: "user", content: source },
        ],
        keep_alive: "30m",
        options: { num_ctx: 4096, num_predict: 220 },
      }),
    });
    if (!upstream.ok) {
      const details = await upstream.text();
      console.error("Failed while compressing the chat:", upstream.status, details);
      return res.status(502).json({ error: "The local model could not compress the chat." });
    }
    const data = await upstream.json();
    const memory = cleanMemory(data.message?.content || "");
    if (memory) desk.rememberChat(memory, history);
    res.json({ memory });
  } catch (err) {
    if (err?.name === "AbortError") return res.status(499).end();
    console.error("Failed while compressing the chat:", err?.message || err);
    res.status(500).json({ error: "Could not compress the chat." });
  }
});

app.post("/open-outlook", async (req, res) => {
  const to = cleanMailAddress(req.body?.to);
  const name = String(req.body?.name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  const subject = String(req.body?.subject || "Re: your email").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const letter = polishReply(String(req.body?.body || "").replace(/\u0000/g, ""), name);
  const body = replyWithOriginal(letter, req.body?.original).slice(0, 20000);
  if (!body) return res.status(400).json({ error: "There is no reply to open." });
  try {
    await openOutlookDraft({ to, subject, body, name });
    desk.finishLatestEmail("Opened in Outlook. Press Send when it looks right.");
    sendControl("desk", {});
    res.json({ ok: true, to });
  } catch (err) {
    console.error("Failed while opening Outlook:", err?.message || err);
    res.status(500).json({ error: "Outlook did not open. Is Microsoft Outlook installed?" });
  }
});

/** Calendar, email, and the other built-in jobs still win unless the user named a skill. */
function looksLikeOwnJob(question) {
  return Boolean(
    desk.parseDesk(question)
    || textMeJob(question)
    || learningJob(question)
    || showSiteJob(question)
    || siteShortcut(question)
    || emailSearchJob(question)
    || openFileJob(question)
    || findOnMacJob(question)
    || meetingJob(question)
    || calendarRead(question)
    || memoJob(question)
    || wantsEmail(question)
  );
}

/**
 * Speak one prepared prompt with the model selected on the page.
 * Used for the meeting summary, which must not run the calendar or email tools.
 * firstEvent is sent before the words, so the page can highlight a skill.
 */
async function streamSpokenPrompt(req, res, prompt, firstEvent, readDirs) {
  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  let reasoning = typeof req.body?.reasoning === "string" ? req.body.reasoning : DEFAULT_REASONING;
  if (!model.reasoning.includes(reasoning)) reasoning = model.reasoning[0];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!model.local && !model.subscription && !apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  if (firstEvent) writeEvent(res, firstEvent);

  if (model.local && loadedLocalId && !ollamaNamesMatch(loadedLocalId, model.id)) {
    try {
      await stopOllamaModel(loadedLocalId);
    } catch (err) {
      console.error("Failed while switching local models:", err?.message || err);
    }
  }
  if (model.local) setLoadedLocalId(model.id);

  res.locals.pdf = pdfCatcher();
  try {
    // longSpoken so a real meeting can be more than three sentences.
    if (model.local) await streamLocalAnswer(prompt, res, model, reasoning, true, true);
    else if (model.subscription) await streamClaudeAnswer(prompt, res, model, reasoning, true, readDirs);
    else await streamAnswer(apiKey, prompt, res, model, reasoning, true);
    await finishPdf(res);
    writeEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    console.error("Failed while summarizing the meeting:", err?.message || err);
    writeEvent(res, {
      type: "error",
      message: clientError(err?.message, "Could not summarize the meeting."),
    });
    res.end();
  }
}

registerMeetings(app);
registerSkills(app);

app.post("/ask", async (req, res) => {
  let question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Type or say a question first." });
  }
  // A meeting or lecture summary must not open the calendar or search the wiki.
  if (req.body?.summarizeLecture === true) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    if (!notes) return replyNow(res, "The lecture was quiet. I did not catch any words.");
    const presenter = oneLine(req.body?.presenter, 80) || "the presenter";
    const title = oneLine(req.body?.title, 120);
    await streamSpokenPrompt(req, res, lectureSummaryPrompt(notes, presenter, title));
    return;
  }
  if (req.body?.summarizeMeeting === true) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    if (!notes) return replyNow(res, "The meeting was quiet. I did not catch any words.");
    await streamSpokenPrompt(req, res, meetingSummaryPrompt(notes));
    return;
  }
  // The page already started Tiny's move. Say a few words while Tiny does it.
  const tinyLine = TINY_LINES[req.body?.tinyMove];
  if (tinyLine) return replyNow(res, tinyLine);
  // A skill is a saved set of instructions. "Use the PRD skill" loads that file.
  const skills = await listSkills();
  const requestedId = typeof req.body?.skill === "string" ? req.body.skill : "";
  if (mentionsSkillStop(question)) return replySkillStop(res);
  const named = matchSkill(question, skills);
  const kept = skills.find((skill) => skill.id === requestedId) || null;
  let activeSkill = named || kept;
  const asksForASkill = /\b(use|grab|open|start|follow) (?:the |a )?skills?\b/i.test(question);
  if (asksForASkill && !named && !kept) {
    if (skills.length === 1) activeSkill = skills[0];
    else if (!skills.length) return replyNow(res, "There are no skills yet. Add one under ~/.claude/skills.");
    else {
      return replyNow(res, `I have ${skills.length} skills. Type / and the skill name.`);
    }
  }
  if (activeSkill && (named || asksForASkill || !looksLikeOwnJob(question))) {
    const notes = cleanMeetingNotes(req.body?.meetingNotes);
    const prompt = skillInstructions(
      activeSkill,
      question,
      cleanHistory(req.body?.history),
      cleanMemory(req.body?.memory),
      notes,
      req.body?.notesKind === "lecture" ? "lecture" : "",
    );
    const readDirs = [];
    if (activeSkill.dir) readDirs.push(activeSkill.dir);
    for (const folder of selected) {
      if (!readDirs.includes(folder)) readDirs.push(folder);
    }
    await streamSpokenPrompt(req, res, prompt, {
      type: "skill",
      id: activeSkill.id,
      name: activeSkill.name,
    }, readDirs);
    return;
  }
  if (isNoise(question)) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "ignored", message: "That was a noise, not a question." });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  const deskCommand = desk.parseDesk(question);
  if (deskCommand?.action === "do") {
    const item = desk.suggestionAt(deskCommand.index);
    if (!item) return replyNow(res, "There is no idea with that number.");
    desk.dismissSuggestion(item.id);
    sendControl("desk", {});
    question = `Draft a reply to the email about ${item.detail}`;
  } else if (deskCommand) {
    try {
      const result = await runDeskCommand(deskCommand);
      if (result) {
        sendControl("desk", {});
        return replyNow(res, result.text, result.card);
      }
    } catch (err) {
      console.error("Failed while running a saved job:", err?.message || err);
      return replyNow(res, "I could not update that job.");
    }
  }
  const textMe = textMeJob(question);
  if (textMe) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "delta", text: await runTextMe(textMe, askBrain) });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  const learning = learningJob(question);
  if (learning) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.flushHeaders?.();
    writeEvent(res, { type: "delta", text: await runMemoryJob(learning) });
    writeEvent(res, { type: "done" });
    return res.end();
  }
  // "Show me cnn.com" opens the browser. A file name is not a web address.
  const site = showSiteJob(question) || siteShortcut(question);
  if (site) {
    try {
      await runCommand("open", [site.url]);
      const label = site.name.toLowerCase() === "inotes" ? "iNotes" : site.name;
      return replyNow(res, `I opened ${label} in your browser.`, { title: label, lines: [site.url] });
    } catch (err) {
      console.error("Failed while opening a web page:", err?.message || err);
      return replyNow(res, `I could not open ${site.name}.`);
    }
  }
  // "Merge the last two PDFs", "rotate it": PDFCraft's tools change a PDF the user has.
  if (wantsPdfTool(question)) {
    try {
      if (await answerPdfTool(question, res)) return;
    } catch (err) {
      console.error("Failed while planning a PDF tool:", err?.message || err);
      if (res.headersSent) return res.end();
    }
  }
  // Email first: "open the email from Sara" must not look for a file called "email from Sara".
  const mailSearch = emailSearchJob(question);
  const openFile = mailSearch ? null : openFileJob(question);
  const findOnMac = mailSearch || openFile ? null : findOnMacJob(question);
  const opened = mailSearch ? await runEmailSearch(mailSearch, rawMail)
    : openFile ? await runOpenFile(openFile, notes, selected, {
      asked: question,
      recentText: fileTalk(cleanHistory(req.body?.history)),
      findByMeaning: (text) => semantic.search(text, 100),
    })
    : findOnMac ? await runFindOnMac(findOnMac) : null;
  if (opened) {
    const text = typeof opened === "string" ? opened : opened.text;
    const card = opened && typeof opened === "object" ? opened.card : { title: "Done", lines: [text] };
    return replyNow(res, text, card);
  }
  if (!notes.length) {
    return res.status(500).json({
      error: "No wiki notes are loaded. Check WIKI_PATH and restart the server.",
    });
  }

  const model = getModel(req.body?.model) || getModel(DEFAULT_MODEL);
  let reasoning = typeof req.body?.reasoning === "string" ? req.body.reasoning : DEFAULT_REASONING;
  if (!model.reasoning.includes(reasoning)) {
    reasoning = model.reasoning[0];
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!model.local && !model.subscription && !apiKey) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY. Add it to the .env file in the project folder.",
    });
  }

  const aboutChat = isChatQuestion(question);
  const history = cleanHistory(req.body?.history);
  const recordedMeeting = cleanMeetingNotes(req.body?.meetingNotes);
  // A question about the recording must not open today's Outlook calendar.
  const aboutRecorded = Boolean(recordedMeeting) && !asksForOutlookCalendar(question);
  const meeting = aboutChat ? null : meetingJob(question);
  const calendarWhen = aboutChat || meeting || aboutRecorded ? null : calendarRead(question);
  const memo = aboutChat || meeting || calendarWhen ? null : memoJob(question);
  const aboutEmail = wantsEmail(question);
  const hits = aboutChat || memo === "save" || meeting || calendarWhen || aboutRecorded
    ? []
    : memo
      ? await memosForPrompt(memo)
      : aboutEmail
        ? await findRawEmails(question, history)
        : await notesForQuestion(question);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (model.local && loadedLocalId && !ollamaNamesMatch(loadedLocalId, model.id)) {
    const previous = getModel(loadedLocalId);
    try {
      const unloaded = await stopOllamaModel(loadedLocalId);
      if (unloaded.stopped) {
        writeEvent(res, {
          type: "status",
          message: `${previous?.label || loadedLocalId} was stopped.`,
        });
      }
    } catch (err) {
      console.error("Failed while switching local models:", err?.message || err);
    }
  }
  if (model.local) setLoadedLocalId(model.id);

  if (!aboutChat && !memo && !meeting && !calendarWhen && !aboutRecorded && shouldBrowse(question)) writeEvent(res, { type: "status", message: "Looking on the web…" });
  const pages = aboutChat || memo || meeting || calendarWhen || aboutRecorded ? [] : await searchWeb(question);
  const sources = [
    ...hits.map(({ note }) => ({ title: note.title, file: note.rel })),
    ...pages.map((page) => ({ title: page.title, file: page.url })),
  ];
  writeEvent(res, { type: "sources", sources });
  if (hits.outlook) writeEvent(res, { type: "outlook", ...hits.outlook });

  // No matching notes often means the question was misheard or unclear.
  // The model still sees it, so it can ask what you meant instead of saying "not in the notes".

  try {
    if (calendarWhen) {
      writeEvent(res, { type: "delta", text: spokenCalendar(calendarWhen) });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    if (meeting) {
      const plan = parseMeeting(question);
      const waiting = spokenMeetingWaiting(plan);
      desk.saveMeetingDraft(plan, waiting);
      sendControl("desk", {});
      writeEvent(res, { type: "work", card: { title: plan.subject, lines: [waiting] } });
      writeEvent(res, { type: "delta", text: waiting });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    if (memo === "save") {
      const said = await spokenSavedMemo(question, model, apiKey);
      writeEvent(res, { type: "delta", text: said });
      writeEvent(res, { type: "done" });
      return res.end();
    }
    const notesKind = req.body?.notesKind === "lecture" ? "lecture" : "";
    let prompt = buildPrompt(question, hits, pages, history, cleanMemory(req.body?.memory), recordedMeeting, notesKind);
    // PDFs in Q/A on the page (pdfedit.js): their text goes with every question.
    prompt += await qaBlock(req.body?.qaPdfs);
    const photo = photoDataUrl(req.body?.photo);
    if (photo && (model.local || model.subscription)) {
      prompt += "\n\nThe user attached a photo. You cannot see pictures. If they ask what the photo shows, say you cannot see it. Do not invent what is in it.";
    } else if (photo) {
      prompt += "\n\nA photo is attached. If the question is about that photo, answer only from what is visible in it. Do not invent words or numbers that are not in the photo.";
    }
    const spoken = req.body?.spoken === true;
    const longSpoken = hits.emailJob === "read" || hits.emailJob === "reply" || hits.emailJob === "send" || hits.emailJob === "list" || hits.emailJob === "review" || hits.memoJob === "recent" || hits.memoJob === "all" || hits.memoJob === "find";
    res.locals.pdf = pdfCatcher();
    if (model.local) await streamLocalAnswer(prompt, res, model, reasoning, spoken, longSpoken);
    else if (model.subscription) await streamClaudeAnswer(prompt, res, model, reasoning, spoken);
    else await streamAnswer(apiKey, prompt, res, model, reasoning, spoken, photo);
    await finishPdf(res);
    writeEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    console.error("Failed while answering:", err?.message || err);
    writeEvent(res, {
      type: "error",
      message: clientError(err?.message, "Something went wrong while answering."),
    });
    res.end();
  }
});

/** Ask through /ask, the same way the page does, and return the whole answer as text. */
async function askBrain(question, history = []) {
  const response = await fetch(`http://127.0.0.1:${PORT}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(safeJson(raw)?.error || `ask failed with ${response.status}`);
  let answer = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = safeJson(line.slice(6));
    if (event?.type === "delta") answer += event.text;
    if (event?.type === "error") throw new Error(event.message);
  }
  return answer.trim();
}

registerIMessage(app, askBrain);

registerPdf(app);
registerPdfTools(app);
registerDeck(app);
registerDeskjobs(app);

/**
 * Morning briefing: today's meetings, tasks due, and emails that need a reply.
 * BRIEFING_AT=08:00 in .env sends it each day; it goes to your iMessage (when on)
 * and an open voice page reads it aloud. GET /briefing makes one now without sending.
 */
async function briefingText() {
  const parts = [`Good morning. ${spokenCalendar("today")}`];
  for (const question of ["Which tasks on my to-do list are due today or overdue? Answer in two or three short sentences.", "Which emails need an urgent reply?"]) {
    try {
      parts.push(await askBrain(question));
    } catch (err) {
      console.error("Failed while building the briefing:", err?.message || err);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

async function deliverBriefing() {
  const text = await briefingText();
  sendControl("briefing", { text });
  try {
    await sendIMessage(text);
  } catch (err) {
    console.error("Failed while texting the briefing:", err?.message || err);
  }
  console.log(`Briefing delivered (voice pages: ${controlClients.size}, iMessage: ${imessageHandle() ? "on" : "off"})`);
  return text;
}

// Watches and reminders keep going while this server is open, including after a restart.
setInterval(() => {
  deliverReminders().catch((err) => console.error("Failed while sending reminders:", err?.message || err));
}, 20_000);

setTimeout(() => {
  deliverReminders().catch((err) => console.error("Failed while sending reminders:", err?.message || err));
}, 5_000);

setInterval(() => {
  checkWatches().catch((err) => console.error("Failed while checking watches:", err?.message || err));
}, 3 * 60_000);

setInterval(() => {
  indexRawMail()
    .then(() => syncSuggestions())
    .catch((err) => console.error("Failed while refreshing suggestions:", err?.message || err));
}, 15 * 60_000);

app.get("/briefing", async (_req, res) => {
  try {
    res.json({ text: await briefingText() });
  } catch (err) {
    console.error("Failed while making the briefing:", err?.message || err);
    res.status(500).json({ error: "Could not make the briefing." });
  }
});

app.post("/briefing/send", async (_req, res) => {
  try {
    res.json({ text: await deliverBriefing() });
  } catch (err) {
    console.error("Failed while sending the briefing:", err?.message || err);
    res.status(500).json({ error: "Could not send the briefing." });
  }
});

/** Keep one voice question and answer for tonight's brain.md summary. */
app.post("/daylog", (req, res) => {
  appendDayLog(req.body?.question, req.body?.answer);
  res.json({ ok: true });
});

/** Summarize one day (default today) into ~/.claude/brain.md with the default model. */
async function summarizeBrainDay(day) {
  const model = getModel(DEFAULT_MODEL);
  const folders = { meetingDir: meetingFolder(), notesDir: memoFolder(), lectureDir: lectureFolder() };
  const result = await summarizeDay(day, folders, (instruction, text) =>
    askModelOnce(model, instruction, text, process.env.OPENAI_API_KEY, 2000, 240000));
  console.log(`brain.md for ${day}: ${result}`);
  if (result === "saved") refreshBrainNotes();
  return result;
}

app.post("/brain/summarize", async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.day || "") ? req.body.day : dayKey();
  try {
    res.json({ day, result: await summarizeBrainDay(day) });
  } catch (err) {
    console.error("Failed while writing brain.md:", err?.message || err);
    res.status(500).json({ error: clientError(err?.message, "Could not write brain.md.") });
  }
});

/**
 * Upload a document from the voice page: a copy and a wiki page go to the meeting folder,
 * and the wiki page joins the notes at once so questions can find it.
 * The page sends the file as raw bytes, its name in X-File-Name.
 */
app.post("/document", express.raw({ type: "*/*", limit: "60mb" }), async (req, res) => {
  let name = "";
  try {
    name = decodeURIComponent(String(req.get("x-file-name") || ""));
  } catch {
    return res.status(400).json({ error: "The file name could not be read." });
  }
  const folder = meetingFolder();
  const model = getModel(req.get("x-model")) || getModel(DEFAULT_MODEL);
  try {
    const doc = await ingestDocument({
      name,
      bytes: Buffer.isBuffer(req.body) ? req.body : null,
      folder,
      ask: (instruction, text) => askModelOnce(model, instruction, text, process.env.OPENAI_API_KEY, 3000, 240000),
    });
    // The meeting folder is <root>/raw/meetings, so the note is relative to that root.
    const root = path.dirname(path.dirname(folder));
    setNotes([...notes, parseNote(path.relative(root, doc.wikiPath), doc.wikiText)]);
    semantic.build(notes).catch((err) => console.error("Failed while building the meaning index:", err?.message || err));
    rememberDocument(doc.copyPath);
    rememberPdf(doc.copyPath);
    console.log(`Saved an uploaded document and its wiki page (${path.extname(doc.copyPath)})`);
    res.json({ title: doc.title, summary: doc.summary, wiki: doc.wikiPath, copy: doc.copyPath });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: clientError(err.message, "That document could not be saved.") });
    console.error("Failed while saving an uploaded document:", err?.message || err);
    res.status(500).json({ error: "Could not save that document." });
  }
});

/** "Clear and save": summarize the conversation on screen into brain.md before the page clears it. */
app.post("/brain/conversation", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 30000) : "";
  if (text.length < 20) return res.status(400).json({ error: "There is no conversation to save yet." });
  try {
    const heading = await saveConversation(text, (instruction, input) =>
      askModelOnce(getModel(DEFAULT_MODEL), instruction, input, process.env.OPENAI_API_KEY, 2000, 240000));
    // Never log the conversation itself. It can name a patient.
    console.log(`brain.md: saved ${heading}`);
    refreshBrainNotes();
    res.json({ ok: true, heading });
  } catch (err) {
    console.error("Failed while saving the conversation to brain.md:", err?.message || err);
    res.status(500).json({ error: "Could not save the conversation to brain.md." });
  }
});

// Each night, write the day into brain.md. If the Mac was off, catch up on yesterday at start.
const BRAIN_SUMMARY_AT = /^\d{1,2}:\d{2}$/.test(process.env.BRAIN_SUMMARY_AT || "") ? process.env.BRAIN_SUMMARY_AT : "23:30";
// Days already tried since this server started, so a day is never written twice.
const brainTried = new Set();
function runBrainSummary(day) {
  if (brainTried.has(day)) return;
  brainTried.add(day);
  summarizeBrainDay(day).catch((err) => console.error("Failed while writing brain.md:", err?.message || err));
}
setInterval(() => {
  const now = new Date();
  const [hour, minute] = BRAIN_SUMMARY_AT.split(":").map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
  runBrainSummary(dayKey(now));
}, 60_000);
setTimeout(() => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  runBrainSummary(dayKey(yesterday));
}, 60_000);
console.log(`brain.md summary set for ${BRAIN_SUMMARY_AT} each night.`);

const BRIEFING_AT = (process.env.BRIEFING_AT || "").trim();
if (/^\d{1,2}:\d{2}$/.test(BRIEFING_AT)) {
  let briefedOn = "";
  setInterval(() => {
    const now = new Date();
    const [hour, minute] = BRIEFING_AT.split(":").map(Number);
    const today = now.toDateString();
    const late = now.getHours() * 60 + now.getMinutes() - (hour * 60 + minute);
    // Only within the first half hour, so a restart at noon does not send a morning briefing.
    if (briefedOn === today || late < 0 || late > 30) return;
    briefedOn = today;
    deliverBriefing().catch((err) => console.error("Failed while sending the briefing:", err?.message || err));
  }, 30_000);
  console.log(`Morning briefing set for ${BRIEFING_AT}.`);
}

startWhisperServer();
startKokoro();

try {
  readSavedFolders();
  await reloadNotes();
} catch (err) {
  console.error("Failed while loading the wiki:", err?.message || err);
}

// Only this Mac can connect; other machines on the network cannot.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\nSecond brain → http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL} (thinking ${DEFAULT_REASONING}). Change it on the page.`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Copy .env.example to .env first.\n");
  }
  if (!notes.length) {
    console.warn(`No notes loaded. Is this path correct?\n${WIKI_PATH}\n`);
  }
});
