/**
 * What kind of question is this? Pure word tests with no side effects: chat, memo,
 * email, meeting, calendar, file search, news, noise. Every route decides from these.
 */


/** Questions about this chat, not the wiki or the web. */
export function isChatQuestion(question) {
  const q = question.toLowerCase();
  return /\b(last time|previous|just asked|did i ask|i ask you|i said|you said|you tell|you told|earlier|a moment ago|before that|repeat that|say that again|what did i)\b/.test(q);
}

/**
 * A new email, not a reply to one already saved.
 * "Send an email to Haitham" counts. "Reply to this email" does not.
 */
export function isComposeEmail(question) {
  const q = question.toLowerCase();
  if (/\b(reply|replies|respond|write\s+back)\b/.test(q)) return false;
  if (/\b(?:this|that|the same)\s+(?:e-?mail|message)\b/.test(q)) return false;
  if (/\b(?:did you|have you|did i)\b/.test(q)) return false;
  if (/\b(?:send|forward)\s+(?:me\s+)?(?:the|that|this)\s+/.test(q)) return false;
  return /\b(?:send|compose|write|draft)\b.{0,40}\b(?:e-?mail|message|letter)\b/.test(q);
}

/** Read one message, draft a reply, write a new email, review the pile, list every email, or just count them. */
export function emailJob(question) {
  const q = question.toLowerCase();
  const writingReply = /\b(draft|write)\b/.test(q) || /\b(reply|respond)\s+to\b/.test(q);
  const reviewing = /\b(review|urgent|urgency|important)\b/.test(q)
    || /\bneed(?:s)?\b.{0,30}\brepl(?:y|ies)\b/.test(q)
    || /\bshould\b.{0,30}\brepl(?:y|ies)\b/.test(q);
  // "Send an important email" is still a new email, not a review of the inbox.
  if (isComposeEmail(question)) return "send";
  if (reviewing && !writingReply) return "review";
  if (/\b(reply|replies|respond|draft)\b/.test(q)) return "reply";
  if (/\b(read|reads|reading|open|contents|body)\b/.test(q)) return "read";
  if (/\b(list|all|every|each)\b/.test(q)) return "list";
  return "count";
}

export function isVaultQuestion(question) {
  const q = question.toLowerCase();
  if (wantsFile(question)) return true;
  return /\b(todos?|to-dos?|to do|todoist|to-?doist|tasks?|plate|have to do|index|logs?|history|wikis?|finished|second brain|e-?mails?|inbox|raw folder)\b/.test(q);
}

/**
 * True when the user is asking where a file is.
 * "Find the ketamine paper" counts. "What is on my to-do list" does not.
 */
export function wantsFile(question) {
  const q = String(question || "").toLowerCase();
  const ask = /\b(find|locate|look(?:ing)? for|search for|where(?:'s| is)|which file)\b/.test(q);
  const noun = /\b(files?|documents?|papers?|pdfs?|docx|xlsx|spreadsheets?|notes?|reports?|decks?|slides?|pages?)\b/.test(q);
  return ask && noun;
}

export function wantsEmail(question) {
  if (memoJob(question)) return false;
  if (emailJob(question) === "send") return true;
  if (/\b(e-?mails?|inbox|raw folder|invitation)\b/i.test(question)) return true;
  return emailJob(question) === "reply";
}

/**
 * A memo is a short note the user asked to keep.
 * "save" writes a new file. "recent" is the past two weeks. "all" is every memo.
 */
export function memoJob(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  // A complaint must not create a new file.
  const complaint = /\b(stupid|do not save|don't save|stop saving)\b/.test(q) || /\bi asked you\b/.test(q);
  // "did you save the memo" is a question. "can you write a memo" is a request.
  const lookingUp = /\b(?:did you|have you|was it|is it|do you have|is there|where is|show me|list|find|what are|what memos)\b/.test(q);
  const creating = /\b(?:save|remember|jot down|write down|take down|write|make|create|add|draft)\s+(?:me\s+)?(?:a\s+|an\s+|this\s+|the\s+|down\s+)?(?:memo|note)\b/.test(q)
    || /\btake\s+(?:a\s+|down\s+)?(?:a\s+)?note\b/.test(q)
    || /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:save|remember|jot down|write down|take down)\b/.test(q);
  const aboutMemo = /\bmemos?\b/.test(q) || (creating && /\bnotes?\b/.test(q));
  if (complaint) return null;
  if (creating && !lookingUp) return "save";
  if (!aboutMemo) return null;
  if (/\ball\b/.test(q)) return "all";
  const oneMemo = /\b(?:about|regarding|did you|have you|where is)\b/.test(q);
  if (lookingUp && oneMemo && !/\b(?:recent|last|past|this week|two weeks)\b/.test(q)) return "find";
  return "recent";
}

/**
 * A request to put a meeting on the calendar.
 * "did you schedule" is a question, so it does not create one.
 */
export function meetingJob(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  const lookingUp = /\b(?:did you|have you|what meetings|show my calendar|what is on my calendar|what's on my calendar)\b/.test(q);
  const creating = /\b(?:schedule|book|set up|arrange)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:meeting|appointment)\b/.test(q)
    || /\b(?:schedule|book|set up|arrange)\b/.test(q) && /\b(?:titled|called|named|title is|call it|title it)\b/.test(q)
    || /\b(?:add|put)\s+(?:a\s+|an\s+|the\s+)?(?:meeting|appointment)\s+(?:on|in|to)\b/.test(q)
    || (/\b(?:meeting|appointment|schedule)\b/.test(q) && /\b(?:on|to|in)\s+(?:my\s+|the\s+)?(?:outlook\s+)?calendar\b/.test(q));
  if (!creating || lookingUp) return null;
  return "schedule";
}

/**
 * A question about what is already on the calendar.
 * "Schedule a meeting" is not this. That still opens a new event.
 */
export function calendarRead(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  const aboutDay = /\b(?:calendar|schedule|agenda|meetings?|appointments?)\b/.test(q);
  if (!aboutDay) return null;
  const asking = /\b(?:what(?:'s| is)|whats|show|tell me|do i have|have i got|anything|list|read)\b/.test(q)
    || /\bon my calendar\b/.test(q);
  const creating = /\b(?:schedule|book|set up|arrange|add|put)\b/.test(q);
  if (creating && !asking) return null;
  if (!asking && !/\b(?:today|tomorrow|tonight)\b/.test(q)) return null;
  if (/\btoday\b/.test(q) && /\btomorrow\b/.test(q)) return "both";
  if (/\btomorrow\b/.test(q)) return "tomorrow";
  return "today";
}

/**
 * The Outlook calendar, as opposed to a meeting that was just written down.
 * "What is still missing from the meeting?" is about the recording.
 * "What meetings do I have today?" is about Outlook.
 */
export function asksForOutlookCalendar(question) {
  const q = String(question || "").toLowerCase();
  return /\b(?:calendar|schedule|agenda|appointments?)\b/.test(q)
    || /\b(?:what|which) meetings?\b/.test(q)
    || /\bmeetings? (?:today|tomorrow|tonight|do i have|have i got)\b/.test(q);
}

/** Whisper writes room sounds in parentheses. Those are not questions. */
export function isNoise(question) {
  const raw = String(question || "").trim();
  if (/^\([^)]*\)$/.test(raw) || /^\[[^\]]*\]$/.test(raw)) return true;
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").trim();
  const junk = new Set([
    "thank you",
    "thanks for watching",
    "you",
    "bye",
    "silence",
    "music",
    "blank audio",
    "door opens",
    "door closing",
    "sighs",
    "sigh",
    "coughing",
    "laughter",
    "background noise",
  ]);
  return !cleaned || junk.has(cleaned);
}

/** "Latest news today", including a mishearing such as "latest in use today". */
export function wantsNews(question) {
  const q = question.toLowerCase();
  if (/\b(news|headline|headlines)\b/.test(q)) return true;
  if (/\blatest\b/.test(q) && /\b(today|tonight|now|in use)\b/.test(q)) return true;
  if (/\b(happening|going on)\b/.test(q) && /\b(today|tonight|now)\b/.test(q)) return true;
  return false;
}

/**
 * A question about this app itself: what it can do, or how one function works.
 * "Rotate the PDF" is a request to do it, so this stays false.
 * "What can you do?" and "How does the watermark work?" are true.
 */

/** The broad "what can you do?" question. A question about one function is not this. */
export function asksForAppOverview(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  const overview = /\b(?:what can you do|what do you do|what are you able to|what are your (?:functions|features|capabilities|abilities)|how do you work|what can this app|what does this app|what does the app|what can the app|tell me what you can|list (?:your|the) (?:functions|features))\b/;
  // "What can you do about the budget?" is about the notes, not the app.
  const aboutWork = /\b(?:about|with|for|on|regarding) (?:my|the|this|that)\b/;
  return overview.test(q) && !aboutWork.test(q);
}

export function asksAboutThisApp(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (asksForAppOverview(question)) return true;
  // A named function from the manual, asked about rather than ordered.
  const feature = /\b(?:pdf tools?|word editor|wordcraft|presentations?|slide decks?|powerpoints?|the terminal|tiny mode|mascot|morning briefing|watermark|page numbers|bookmarks|q\/a)\b/;
  const asking = /\b(?:how|what|which|can you|do you|does (?:it|the app)|are you able|explain|tell me about)\b/;
  if (feature.test(q) && asking.test(q)) return true;
  // "How do I split a PDF?" names the job in either order.
  const howTo = /\bhow (?:do|can|does|to)\b/;
  const job = /\b(?:pdfs?|word|slides?|presentation|deck|terminal|meetings?|lectures?|memos?|watermark|signature|bookmarks?|compress|ocr)\b/;
  return howTo.test(q) && job.test(q);
}

/** Questions whose answer changes over time, or that ask for the web outright. */
export function needsFreshFacts(question) {
  const q = question.toLowerCase();
  if (wantsNews(question)) return true;
  if (/\b(search|google|look up|online|on the web|internet)\b/.test(q)) return true;
  return /\b(today|tonight|tomorrow|yesterday|now|current|currently|latest|recent|recently|this (week|month|year)|price|prices|cost of|weather|forecast|score|stock|exchange rate|who won|released?|20[2-9]\d)\b/.test(q);
}
