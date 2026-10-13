/**
 * Medical speech: GPT-OSS 20B on this Mac cleans a transcript.
 *
 * It does not answer. It only:
 * - keeps the medical words and drops the rest
 * - translates that part into English
 * - takes out names, record numbers, phones, and other identifiers
 * - if the speaker is asking the assistant something, writes that question
 *   so the page can send it to the brain
 *
 * The spoken words never leave this Mac. The log records only yes/no, never the words.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MEDGEM_MODEL = "gpt-oss:20b";

const SCHEMA = {
  type: "object",
  properties: {
    medical: { type: "boolean" },
    english: { type: "string" },
    for_brain: { type: "string" },
  },
  required: ["medical", "english", "for_brain"],
};

// Short examples so the small model copies the shape. All of these are made up.
const EXAMPLES = [
  [
    "Hello, nice weather today. The child has had fever for three days and a cough.",
    { medical: true, english: "The child has had fever for three days and a cough.", for_brain: "" },
  ],
  [
    "Patient Sara Haddad, file number 445566, phone 0791112233, has neutropenia after chemotherapy.",
    { medical: true, english: "The patient has neutropenia after chemotherapy.", for_brain: "" },
  ],
  [
    "Patient Omar Nasser, born 2 February 2014, in room 12, has a fever.",
    { medical: true, english: "The patient has a fever.", for_brain: "" },
  ],
  [
    "عند الطفل حرارة من يومين ونقص عدلات",
    { medical: true, english: "The child has had fever for two days and neutropenia.", for_brain: "" },
  ],
  [
    "Give ceftriaxone 50 mg per kg. Did you already give the morning dose?",
    {
      medical: true,
      english: "Ceftriaxone 50 mg per kg was ordered. Someone was asked whether the morning dose was already given.",
      for_brain: "",
    },
  ],
  [
    "Let's get coffee after the meeting.",
    { medical: false, english: "", for_brain: "" },
  ],
  [
    "Hey, what is our protocol for febrile neutropenia?",
    {
      medical: true,
      english: "What is our protocol for febrile neutropenia?",
      for_brain: "What is our protocol for febrile neutropenia?",
    },
  ],
  [
    "I need our note on vancomycin dosing.",
    {
      medical: true,
      english: "A note on vancomycin dosing was requested.",
      for_brain: "What is our note on vancomycin dosing?",
    },
  ],
];

function promptFor(text) {
  const examples = EXAMPLES.map(([heard, cleaned]) => `Heard: ${heard}\n${JSON.stringify(cleaned)}`).join("\n\n");
  return [
    "You clean a doctor's speech transcript. You do not answer, and you do not give medical advice.",
    "Return only the JSON object.",
    "medical is true only when the words include clinical content: symptoms, exam, diagnosis, medicines, labs, imaging, treatment, or a medical question.",
    "medical is false for greetings, weather, jokes, and other non-medical talk. Then english and for_brain are empty.",
    "english is the medical part only, written in English. Drop every non-medical word. If the words are already English, still rewrite them.",
    "Remove identifiers from english and from for_brain: people's names, medical record numbers, file numbers, phone numbers, email addresses, street addresses, national ID numbers, exact dates of birth, and room or bed numbers.",
    "Keep age, sex, and the clinical facts. Keep relative time such as yesterday or for three days.",
    "for_brain is the speaker's question for the notes assistant, copied into English, with identifiers removed. It is not an answer.",
    "When the speaker says Hey and then asks something, for_brain must be that question. It must not be empty.",
    "Also set for_brain when they ask for a protocol, a prior note, a lookup, or a dose from the records.",
    "A question spoken to a patient, a nurse, or a colleague is dictation. Leave for_brain empty for that.",
    "Pure dictation, an order, or narration leaves for_brain empty.",
    "Do not invent a question from plain dictation. Do not write medical advice in english or in for_brain.",
    "When you set for_brain, write the question so it can be answered on its own, using the clinical facts but no identifiers.",
    "",
    examples,
    "",
    `Heard: ${text}`,
  ].join("\n");
}

/**
 * The question to send to the brain.
 * GPT-OSS fills for_brain when it is sure. If it only wrote the question into english,
 * Hey at the start (or a request for a note or protocol) still counts.
 */
function questionForBrain(raw, english, fromModel) {
  const woke = /^(?:hey\b|هاي|يا\s*دماغي)/i.test(String(raw || "").trim());
  let question = fromModel || "";
  if (!question && english) {
    const lookup = /\b(our note|our protocol|what did i|can you find|find our note)\b/i.test(english);
    if (woke || lookup) {
      question = english.replace(/^(?:hey\b(?:\s+my\s+brain\b)?|هاي|يا\s*دماغي)[\s,.:;!?،\-]*/i, "").trim();
    }
  }
  // "Did you give the dose?" is said to someone in the room. Only Hey, or a lookup, goes to the brain.
  if (question && !woke && /^(did you|have you|can you|could you|would you)\b/i.test(question)) {
    if (!/\b(our note|our protocol|what did i|find our note)\b/i.test(question)) return "";
  }
  return question;
}

/** Drop a hidden think block if the model wrote one before the real answer. */
function visibleText(raw) {
  return String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Read the JSON object, even if a bit of extra text is wrapped around it. */
function parseCleaned(raw) {
  const text = visibleText(raw);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("GPT-OSS did not return JSON.");
  }
}

/** A second short pass only when two capitalized words in a row look like a person's name. */
async function dropNames(sentence) {
  if (!/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(sentence)) return sentence;
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MEDGEM_MODEL,
      prompt: [
        "Rewrite the sentence with no person names.",
        "Say the patient instead of a name. Keep the medical facts. Do not add advice.",
        `Sentence: ${sentence}`,
        "Rewritten:",
      ].join("\n"),
      stream: false,
      // This model ignores "off". Low is the smallest amount of thinking it will do.
      think: "low",
      keep_alive: "30m",
      // Thinking tokens count toward num_predict, so the cap has to be larger than the sentence.
      options: { temperature: 0, num_predict: 1600, num_ctx: 4096 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) return sentence;
  const data = await response.json();
  const rewritten = stripObviousIds(visibleText(data.response).replace(/^["']|["']$/g, ""));
  return rewritten || sentence;
}

/** Drop phone numbers, emails, dates of birth, and labeled record numbers the model may have left in. */
function stripObviousIds(text) {
  return String(text || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\b(?:\+?\d[\d\s().-]{6,}\d)\b/g, "")
    .replace(/\b(?:mrn|file number|national (?:id|number)|id number)\s*[:#]?\s*[A-Z0-9-]{3,}\b/gi, "")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi, "")
    .replace(/\b(?:born|dob|date of birth)\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

/**
 * @param {string} text What the microphone heard, in any language.
 * @returns {Promise<{ medical: boolean, english: string, question: string, ms: number }>}
 */
export async function cleanMedical(text) {
  const started = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MEDGEM_MODEL,
      prompt: promptFor(text),
      stream: false,
      // This model ignores "off". Low is the smallest amount of thinking it will do.
      think: "low",
      format: SCHEMA,
      keep_alive: "30m",
      // 4096 is enough for one transcript. num_predict includes the hidden thinking.
      options: { temperature: 0, num_predict: 2000, num_ctx: 4096 },
    }),
    // The first call loads the model. Later calls are much faster.
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = await response.json();
  const parsed = parseCleaned(data.response);
  const medical = Boolean(parsed.medical);
  let english = medical ? stripObviousIds(parsed.english) : "";
  if (english) english = await dropNames(english);
  // Hey, or a clear lookup, is a question even when the model leaves for_brain blank.
  let question = medical ? questionForBrain(text, english, stripObviousIds(parsed.for_brain)) : "";
  if (question) question = await dropNames(question);
  const ms = Date.now() - started;
  // Never log the transcript. It can name a patient.
  console.log(
    `GPT-OSS medical: medical ${medical ? "yes" : "no"}, question ${question ? "yes" : "no"}, ${data.eval_count ?? "?"} tokens, ${ms} ms`
  );
  return { medical: Boolean(english || question), english, question, ms };
}

/** Load GPT-OSS now, so the first sentence is not waiting on a cold start. */
export async function warmMedgem() {
  await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MEDGEM_MODEL,
      prompt: "",
      stream: false,
      keep_alive: "30m",
      options: { num_ctx: 4096 },
    }),
    signal: AbortSignal.timeout(90000),
  });
}
