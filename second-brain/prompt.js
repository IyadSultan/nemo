/**
 * The words the models see: the standing instructions, the spoken-style rules,
 * ~/.brain/code.md, and the prompt built from notes, web pages and the chat so far.
 */

import { agentsBlock, brainBlock, inBrainBlock, inTodayBlock, todayBlock } from "./brain.js";
import { CODE_FILE, MANUAL_FILE } from "./config.js";
import { DECK_ABILITY } from "./deck.js";
import { isVaultQuestion, wantsEmail, wantsFile, wantsNews } from "./intents.js";
import { learningsBlock } from "./learnings.js";
import { replyDraftNote, sendDraftNote } from "./mail.js";
import { noteBody } from "./notes.js";
import { wantsPubmed } from "./pubmed.js";
import { hereAndNow } from "./spoken.js";
import { selected } from "./state.js";
import fs from "node:fs";
import path from "node:path";

// ~/.brain/manual.md. Loaded only when a question is about this app.
let manualCache = { mtime: 0, text: "" };

/** The full text of manual.md. Empty if the file is missing. Cached until the file changes. */
export function appManualText() {
  try {
    const mtime = fs.statSync(MANUAL_FILE).mtimeMs;
    if (mtime !== manualCache.mtime) {
      manualCache = { mtime, text: fs.readFileSync(MANUAL_FILE, "utf8") };
    }
    return manualCache.text;
  } catch (err) {
    console.error("Failed while reading the app manual:", err?.code || err?.message || err);
    return "";
  }
}

/**
 * The prompt for "what can you do?" and for a question about one function.
 * The model must answer from the manual, not from memory.
 */
export function appManualPrompt(question, history = [], memory = "") {
  const manual = appManualText();
  const earlier = history.length
    ? history.map((turn) => `User: ${turn.question}\nAssistant: ${turn.answer}`).join("\n\n")
    : "";
  return [
    "The user is asking what this app can do, or how one of its functions works.",
    "Answer only from the app manual below. A broad question gets a short spoken overview of the main things. A specific question gets that part, in a few plain sentences.",
    "Do not invent a function the manual does not describe. Do not say the app cannot do something the manual says it does.",
    "Do not read headings, file paths, or code names aloud.",
    "If they asked what you can do in general, do not end by offering more detail, and do not mention /brain. The app adds that last sentence itself.",
    manual ? `App manual:\n${manual}` : "The app manual is missing. Say you could not open it.",
    memory ? `Compressed memory of older turns:\n${memory}` : "",
    earlier ? `Earlier in this conversation:\n${earlier}` : "",
    `Question: ${question}`,
  ].filter(Boolean).join("\n\n");
}

export function buildPrompt(question, hits, pages = [], history = [], memory = "", meetingNotes = "", notesKind = "", files = []) {
  const learned = brainBlock();
  const today = todayBlock();
  // A brain.md day, or a call already in today's block, is not repeated as a note.
  const blocks = hits.filter((hit) => !inBrainBlock(hit.note.rel, learned) && !inTodayBlock(hit.note.rel, today)).map((hit) => {
    const { note, terms } = hit;
    return [
      `Note: ${note.title}`,
      `File: ${note.rel}`,
      hit.override || noteBody(note, terms),
    ].join("\n");
  });

  const webBlocks = pages.map((page) => {
    return [`Page: ${page.title}`, `Address: ${page.url}`, page.text].join("\n");
  });

  const memoNote = hits.memoJob === "find"
    ? "The user is asking whether one particular memo was saved. Look only at the memos below. If one is about that subject, say yes, say its date, then say the memo in one clear sentence. If none match, say that memo was not saved. Do not invent one. Do not mention a file name."
    : hits.memoJob === "recent" || hits.memoJob === "all"
      ? `These are the user's own memos. The first sentence must be: ${hits.sayThis || "You have no memos."} Then say each memo in clearer words, one short sentence each, newest first. Say the date that is on the Date line, in those words. Do not say the word Saved. Do not add facts that are not there. Do not mention a file name. If there are no memos below, stop after that first sentence.`
      : "";
  const pubmedNote = wantsPubmed(question)
    ? pages.length
      ? "The user asked to search PubMed. The pages that start with PubMed: are the articles it found. Answer from them: name each article's first author, year and main finding in one short sentence. Do not invent articles or numbers that are not there."
      : "The user asked to search PubMed, but the search found nothing or PubMed did not answer. Say so in one sentence and suggest a different search term."
    : "";
  const newsNote = wantsNews(question)
    ? "The user wants today's news. Summarize three or four headlines from the web pages in plain sentences. Do not ask which topic."
    : "";
  const vaultNote = wantsFile(question)
    ? "The user asked to find a file. The notes start with lines from wiki/index.md and passages from wiki/log.md. He calls wiki/log.md logs dot md. Use those lines to name the page. If they do not mention the file, say you looked in the index and in the log and did not find it."
    : wantsEmail(question)
    ? hits.emailJob === "read"
      ? `Read this one email aloud. The first sentence must be: ${hits.sayThis || "I could not find that email."} Then say what the message itself asks, in a few short sentences. The arrival time is only the one in that first sentence. Do not mention other files or how many files are in the folder.`
      : hits.emailJob === "reply"
        ? replyDraftNote(hits.outlook)
        : hits.emailJob === "send"
          ? sendDraftNote(hits.outlook)
          : hits.emailJob === "review"
          ? "The user wants to know which emails need an urgent reply. Look at every email below. Name only the ones that need a reply soon, and say why in one short sentence. If none do, say that none of today's emails need an urgent reply. Do not write the reply. Do not list every email. Do not say a date, a clock time, or a file size."
          : hits.emailJob === "list"
          ? `The first sentence must be: ${hits.sayThis || "You have no new emails today."} Then summarize every email below, in order, one short sentence each. Say what it is about. Do not skip one. Do not read the subject from start to finish. Do not say a date, a clock time, or a file size.`
          : `This question is about how many emails arrived. The first sentence must be: ${hits.sayThis || "The raw folder has no email files."} Then summarize two or three of the newest emails, one short sentence each. Say what each one is about. Do not read the subject from start to finish. Do not say a date, a clock time, or a file size. Do not call the whole-folder number today's mail.`
    : isVaultQuestion(question)
      ? "This question is about the user's own second brain. Answer from the notes, especially wiki/todo.md for tasks. Do not use the web. Do not say a listed file is missing if its text is below."
      : "";

  const earlier = history.length
    ? history.map((turn, index) => {
        const label = index === history.length - 1 ? "Last question" : `Earlier question ${index + 1}`;
        return `${label}: ${turn.question}\nAnswer: ${turn.answer}`;
      }).join("\n\n")
    : "(this is the first question in this chat)";
  const chatNote = [
    history.length
      ? "If the user asks what they asked last time, what you just said, or a follow-up, answer from Earlier in this conversation. Do not say that is missing from the notes."
      : "",
    today
      ? "Today so far is in the prompt. If they ask what they asked earlier today, or what you said today, and this chat does not have it, answer from Today so far."
      : "",
  ].filter(Boolean).join(" ");

  const memoryBlock = memory
    ? `Compressed memory of older turns:\n${memory}`
    : "";
  const talk = notesKind === "lecture";
  const meetingBlock = meetingNotes
    ? talk
      ? [
          "A talk written down in this call, in the order it was heard:",
          meetingNotes,
          "If the user asks about that talk or lecture, answer from those lines. Do not say the talk is missing from the notes. Do not invent people, numbers, or claims that are not written there.",
        ].join("\n")
      : [
          "Meeting written down in this call, in the order it was heard:",
          meetingNotes,
          "If the user asks about that meeting, answer from those lines. Do not say the meeting is missing from the notes. Do not invent people, numbers, or decisions that are not written there. Do not turn a question about this meeting into a new calendar event.",
        ].join("\n")
    : "";

  return [
    // here_and_now already ran. The model must copy these words, not invent a clock time.
    `Here and now: ${hereAndNow()}`,
    learningsBlock(),
    learned,
    today,
    agentsBlock(),
    memoryBlock,
    meetingBlock,
    "Earlier in this conversation:",
    earlier,
    "",
    `Question: ${question}`,
    "",
    "Notes:",
    blocks.length ? blocks.join("\n\n---\n\n") : "(no notes matched the words in this question)",
    "",
    conversationFilesBlock(files),
    "",
    "Web pages:",
    webBlocks.length ? webBlocks.join("\n\n---\n\n") : "(no web pages were looked up)",
    "",
    // A messy sentence can still be a real question. Only stop when there is no topic at all.
    "Reminder: if you can tell what the user wants, answer it, even if the wording is clumsy.",
    "Ask one short clarifying question only when there is no topic, for example a noise or 'can you hear me'.",
    newsNote,
    pubmedNote,
    memoNote,
    vaultNote,
    chatNote,
  ].filter(Boolean).join("\n");
}

/** Keep only recent, short turns. The page sends these with the next question. */
export function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const item of raw) {
    const question = typeof item?.question === "string" ? item.question.trim().slice(0, 500) : "";
    const answer = typeof item?.answer === "string" ? item.answer.trim().slice(0, 1500) : "";
    if (!question) continue;
    turns.push({ question, answer: answer || "(no answer yet)" });
  }
  return turns.slice(-6);
}

export function cleanMemory(raw) {
  return typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
}

/**
 * Files the user added with the paperclip, or files this chat made (a PDF, a deck, a Word file).
 * A file with no name is dropped. Only the latest few are kept.
 */
export function cleanChatFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const files = [];
  for (const item of raw) {
    const name = typeof item?.name === "string" ? item.name.replace(/[\r\n]/g, " ").trim().slice(0, 180) : "";
    if (!name) continue;
    files.push({
      name,
      title: typeof item?.title === "string" ? item.title.replace(/[\r\n]/g, " ").trim().slice(0, 180) : "",
      summary: typeof item?.summary === "string" ? item.summary.replace(/\s+/g, " ").trim().slice(0, 1200) : "",
      wiki: typeof item?.wiki === "string" ? item.wiki.trim().slice(0, 500) : "",
      made: item?.made === true,
    });
  }
  return files.slice(-8);
}

/**
 * True when the question is about a file already in this chat, not a search of the notes.
 * "What is this document about? I just uploaded it" counts. "Find the ketamine paper" does not.
 */
export function asksAboutChatFile(question) {
  const q = String(question || "").toLowerCase();
  if (/\b(this|that)\s+(document|file|pdf|paper|deck|slides?|presentation)\b/.test(q)) return true;
  if (/\b(just\s+)?(uploaded|attached)\b/.test(q)) return true;
  if (/\b(the|this)\s+(file|document|pdf|deck|slides)\s+(i|you)\s+(just\s+)?(made|saved|wrote|uploaded|added|attached)\b/.test(q)) return true;
  if (/\b(i|you)\s+(just\s+)?(made|saved|wrote|uploaded|added|attached)\s+(this|that|the|a|an)?\s*(file|document|pdf|deck|slides)\b/.test(q)) return true;
  return false;
}

/** The words the model sees for the files in this chat. Empty when there are none. */
export function conversationFilesBlock(files) {
  if (!files?.length) return "";
  const lines = files.map((file) => {
    const kind = file.made ? "Made in this chat" : "Added to this chat";
    const title = file.title && file.title !== file.name ? ` — ${file.title}` : "";
    const summary = file.summary ? `\n${file.summary}` : "";
    const text = file.text ? `\nText from the file:\n${file.text}` : "";
    return `- ${kind}: ${file.name}${title}${summary}${text}`;
  });
  return [
    "Files in this conversation:",
    ...lines,
    "The newest file is the current document. If the user says this document, this file, the file I uploaded, the file you made, or asks what they just added, answer from that file. Its name is the one listed. Do not say the file has no name. Do not answer about a different note.",
  ].join("\n");
}

/**
 * Read the wiki page of the newest file, but only if it sits inside the vault.
 * A path outside the vault is ignored, so a question cannot pull in some other file.
 */
export function withChatFileText(files, root) {
  if (!files?.length) return [];
  const base = path.resolve(String(root || ""));
  return files.map((file, index) => {
    if (index !== files.length - 1) return file;
    const text = wikiExcerpt(file.wiki, base);
    return text ? { ...file, text } : file;
  });
}

/** The start of a wiki page, or "" when the path is missing, outside the vault, or unreadable. */
export function wikiExcerpt(wikiPath, root) {
  const wiki = String(wikiPath || "");
  if (!wiki.toLowerCase().endsWith(".md")) return "";
  const full = path.resolve(wiki);
  const base = path.resolve(String(root || ""));
  if (!base || (full !== base && !full.startsWith(base + path.sep))) return "";
  try {
    return fs.readFileSync(full, "utf8").slice(0, 3500);
  } catch (err) {
    console.error("Failed while reading a conversation file:", err?.code || "");
    return "";
  }
}

// Short map of CLAUDE.md, the vault's operating manual.
// The full manual is long. This is the part the model needs to find files.
export const BRAIN_MAP = [
  "The selected folder is a second brain: raw documents in raw/ and wiki pages in wiki/. The user may call wiki/ the wikis folder. There is no folder named wikis.",
  "Notes can also be PDF and Word files. Their File line ends in .pdf or .docx. Treat them like any other note.",
  "Three files are real and matter on every question about his notes. Do not say they are missing when their text is in the notes.",
  "wiki/todo.md holds every to-do, newest on top. He may call it to-do dot md or Todoist. For tasks, today, the to-do list, or Todoist, answer from this file and name the open tasks.",
  "wiki/index.md lists every wiki page. For any other question, start there.",
  "wiki/log.md records where files were added or mentioned. He calls it logs dot md. Answer history questions from it.",
  "When the user asks to find a file, look through wiki/index.md and wiki/log.md before saying it is missing.",
  "New emails are text files in raw/ at the vault root, not wiki pages. Answer email questions from those files.",
].join(" ");

// The app does these itself, before the model sees the question. Reaching the model means the words were not recognized.
export const APP_ABILITIES = [
  "This app does these things itself when the user says the matching words. Never say the app cannot do them. If such a request reaches you, the words were not recognized: tell the user the phrase to say.",
  "Text the user's own phone: say text me, then the message, or send me an iMessage saying, then the message.",
  "Save a memo: say remember that, then the fact. List memos: say what are my memos.",
  "Keep a standing rule for every answer: say from now on, remember, or save a memory, then the rule. That rule also goes on the stickies board with the Claude mark instead of a pin. Say save a sticky or add a sticky for an ordinary note with a pin. List rules and memos: say what are your memories. Remove one: say forget, then what it was about.",
  "Draft an email: say send an email to, then the name and what it says. A draft waits on the page. The user says send it, or presses Open. Outlook opens the draft. The user presses Send. Say don't to drop it.",
  "Put a meeting on the calendar: say schedule a meeting with, then the person, day, and time. It waits until the user says send it. Outlook then opens the event to check and save. Say don't to drop it.",
  "Save a plan: say add a plan, then the trip or the talk and the day. It is saved with the plans and a text goes out the day before. The app then asks: should I add this to your calendar? The user says yes, or presses Add to calendar. Outlook opens it. The user presses Add. Say no to leave it in the plans only.",
  "Show a web page in the browser: say show me, then the address, such as show me cnn.com. It opens right away. A saved place works the same way: if a memory says go to inotes opens a site, then go to inotes opens that site.",
  "Watch a public web page: say watch, then the address. A change texts the user's phone.",
  "Watch for a person: say tell me when, then the name, then emails. A new saved email from that person texts the phone. Say stop watching email from, then the name, to stop.",
  "Watch for an early meeting: say text me if I have a meeting before 9. It texts when one starts before that hour, later today or tomorrow. Say stop watching meetings to stop.",
  "Today's questions and answers are remembered right away. The user can ask what they asked earlier today before the nightly summary.",
  "While an answer is still being written, the user can say stop, make it shorter, instead, then what to do, or do, then a task, then first. The helper continues from what it already wrote.",
  "A reminder: say remind me in 20 minutes to, then the task. It still fires after a restart.",
  "A repeating job: say every weekday at 8 am, text me, then the question. Or say every day at 9 pm, remind me to, then the task. It is read aloud and texted. Say pause, resume, or drop, then a few words from the job. Say change the email job to 9 am to move the clock.",
  "The last conversation is saved on this Mac and comes back the next time they press Start talking.",
  "Open a file: say open, then the file name. It looks in the notes first, then the whole Mac. A Word file opens in LibreOffice, where the user can read and edit it. Say open, then what it is about, then word document. This works when the file name is Arabic and the user asks in English. Never say you cannot open a file. Never tell the user to rename it or to save a PDF just so it can be opened.",
  "Find an email: say find the email from, or about, then the name or subject. Then say open number one, two, or three, and Outlook searches for it.",
  "Search the whole Mac like the Finder: say find, then the file name, then on my Mac. Then say open number one, two, or three.",
  "Write code or make an artifact (a script, an app, a web page, a game, a tool): say write, make, or build, then what it is, such as make a tip calculator app. A team of helpers writes the parts at the same time and Claude puts them together and tests them, in a new folder under ~/.brain/workspace. If the request is unclear, the app first asks up to 3 questions; the next reply answers them. A web page opens in the browser when it is done. Never say you cannot write code.",
  "Read today's or tomorrow's calendar, today's emails, and which emails need an urgent reply.",
  "Show the calendar on screen: say open the calendar. It shows the days Outlook has ready on this Mac. Say close the calendar to go back to the transcript.",
  "Add an appointment from the calendar: say add an appointment, or press Add appointment. Outlook opens it. It is not saved until the user presses Add in Outlook.",
  "The app never sends an email by itself.",
  "When the user asks what you can do, or how one function works, the prompt includes the app manual (manual.md). Answer only from that manual.",
].join(" ");

// The model makes a PDF by writing HTML after PDF_BODY. This server prints it and shows it on the page.
export const PDF_ABILITY = [
  "You can make a PDF. Do it when the user asks for a PDF, a one-pager, a printable or downloadable document, a report, or a summary to save or share. Never say you cannot create or save files.",
  "To make one: say one or two short spoken sentences about what the PDF holds. Then put PDF_BODY on its own line. Then write one complete HTML document with its own CSS in a style tag, sized for A4 (@page { size: A4; margin: 0 } and about 12mm of padding), with a title tag. Colors, cards, tables, and simple inline SVG diagrams print well. Keep the content honest: only facts from the notes, the conversation, or the web excerpts, with a short sources line.",
  "The app turns the HTML into a PDF, shows it on the screen, and gives the user Save and Open buttons. The voice reads only the words before PDF_BODY, so never mention the HTML, and never put PDF_BODY in an answer that has no document.",
].join(" ");

export const INSTRUCTIONS = [
  "You answer questions from a personal wiki of work notes, and from web pages this Mac looked up.",
  BRAIN_MAP,
  APP_ABILITIES,
  "The prompt may list Things the user asked you to always keep in mind. Follow them in every answer, unless one conflicts with a rule about facts or safety.",
  "Use the note excerpts for the user's own work. Use the web page excerpts only for facts that are not in the notes.",
  "If the wording is clumsy but a topic is clear, answer that topic. A request for the latest news means a short briefing of today's headlines.",
  "Ask what they mean only when there is no topic at all, such as a noise or 'can you hear me'.",
  "For follow-ups and questions about the chat, such as what the user asked last time, use Earlier in this conversation. Do not say a chat question is missing from the notes.",
  "Be brief and direct. Use a note only when that note actually states the fact. If the fact is only on a web page, say you found it on the web. Do not call a web page a note.",
  "Do not invent people, dates, or tasks.",
  "Answer in the language of the question. If the user asks in Arabic, answer in Arabic.",
  "The here_and_now tool already ran. Its words are the Here and now line. Use that line for the time, the date, and the place. Do not guess, and do not look those up on the web.",
  "When the user asks for today's emails, leave out those from donotreply@khcc.jo. Say how many emails there are and who they are from, then summarize each one.",
  PDF_ABILITY,
  DECK_ABILITY,
].join(" ");

// The voice reads every word exactly as it is written. It does not turn abbreviations into speech.
export const SPOKEN_STYLE = [
  "Your answer will be read aloud by a voice assistant. The voice reads the words literally. Write only what you want heard.",
  "These spoken rules cover only the words before a PDF_BODY or DECK_BODY marker. After PDF_BODY, write HTML; after DECK_BODY, write the JSON deck.",
  "Use plain spoken sentences only.",
  "No markdown: no headings, bullet points, numbered lists, bold, italics, tables, file size, or code.",
  "No asterisks, hashes, backticks, underscores, slashes, brackets, emoji, links, web addresses, file paths, or HTML tags.",
  "Do not end with a 'Note:' or 'Source:' line. If you name the note, say it inside a sentence, for example: Your to-do list note says...",
  "Turn a list into one sentence, for example: first..., then..., and finally....",
  "Write dates and times as full words. Say October, not a three-letter month. Say nine eleven in the evening, not a clock code. Say kilograms, not an abbreviation.",
].join(" ");

/** The shared rulebook at ~/.brain/code.md. Empty if that file is missing. */
function codeText() {
  try {
    return fs.readFileSync(CODE_FILE, "utf8").trim().slice(0, 8000);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Failed while reading code.md:", err?.message || err);
    return "";
  }
}

/** The rulebook the model must follow, plus which notes folders are in use. */
export function guideBlock() {
  const where = selected.length
    ? `Notes folders in use: ${selected.map((folderPath) => path.basename(folderPath)).join(", ")}.`
    : "No second-brain folder is selected.";
  const guide = codeText();
  if (!guide) return `${where}\nThere is no code.md in the brain folder. Treat the notes as a normal wiki.`;
  return [
    where,
    "Read and follow this code.md. It is the rulebook for how this second brain works:",
    guide,
  ].join("\n");
}

// What Tiny, the character on the page, says while doing a move the user asked for.
export const TINY_LINES = {
  dancing: "Sure, watch this.",
  hand_wave: "Hello there!",
  coffeedrink: "Coffee break. Don't mind if I do.",
  bobbateadrink: "Bubble tea time.",
  celebration: "Woohoo! Let's celebrate.",
};

export function voiceInstructions() {
  return [
    "On the screen you are Tiny, a small cartoon character. When the user asks you to dance, wave, drink coffee or bubble tea, or celebrate, the screen shows Tiny doing it. Say yes in a few words. Do not say you have no body.",
    "You are the user's second brain, in a live voice call.",
    "His to-dos are all in wiki/todo.md. He may call that file to-do dot md or Todoist. Todoist is this file, not the Todoist app.",
    "wiki/index.md is the index of all wiki pages. He may call that file index dot md.",
    "wiki/log.md is the history of the wiki. He may call that file logs dot md. There is no separate logs.md.",
    "Notes can also be PDF and Word files. search_notes finds those too.",
    "When he asks you to find a file, call search_notes. That search reads the index and logs dot md. Look carefully at both before you say the file is missing.",
    "Stay silent unless the user's words start with Hey. Otherwise do not speak.",
    "You can hear the user through the microphone. Never say you cannot hear audio.",
    "Finish each reply. Do not stop mid-sentence.",
    "The voice reads every word literally. Say full month names and say the time in words, such as nine eleven in the evening.",
    "Follow the code.md rulebook included below. It lives in the brain folder and applies to every notes folder.",
    "When the user asks the time, the date, or where they are, call here_and_now. Say the words that tool returns.",
    "When the user asks about their work, people, projects, or tasks, call search_notes first.",
    "Answer those questions only from the notes the tool returns and from the code.md rulebook.",
    "If the notes do not contain the answer, say you could not find it in the notes.",
    "For a simple check like can you hear me, just confirm that you can hear them.",
    "In this live call you can only search notes and tell the time, unless he asks what you can do or how a function works. Then call app_manual first and answer only from what it returns. A broad question gets a short overview. A specific question, such as how the PDF watermark works, gets that part in a few sentences. Do not invent a function. Do not say the app cannot do something the manual describes.",
    "A what-can-you-do answer must end with this exact sentence: If you want every phrase you can tell me, type /brain, or say brain functions. That shows a table of the commands and what each one does.",
    "The app can also text his phone, save memos and rules, open files, show a web page, draft emails, edit PDFs, edit Word, and make slides. If he asks you to do one of those in this live call, say it works in the regular voice mode and ask him to switch. Never say the app cannot do them.",
    "Follow the things the user asked you to always keep in mind, listed below.",
    "",
    learningsBlock(),
    brainBlock(),
    todayBlock(),
    agentsBlock(),
    guideBlock(),
  ].join("\n");
}
