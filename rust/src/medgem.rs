//! Rust port of `second-brain/medgem.js`.
//!
//! Medical speech: GPT-OSS 20B on this Mac cleans a transcript.
//!
//! It does not answer. It only:
//! - keeps the medical words and drops the rest
//! - translates that part into English
//! - takes out names, record numbers, phones, and other identifiers
//! - if the speaker is asking the assistant something, writes that question
//!   so the page can send it to the brain
//!
//! The spoken words never leave this Mac. The log records only yes/no, never the words.
//!
//! The identifier patterns follow JS regex rules exactly (ASCII `\b` and `\d`,
//! JS whitespace, no Unicode case folding), so Rust removes exactly what Node removes.

use crate::js::{self, JS_B as B, JS_SPACE as S};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

const MEDGEM_MODEL: &str = "gpt-oss:20b";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{B}", B).replace("{S}", S)).unwrap()
}

#[derive(Serialize)]
struct Example {
    medical: bool,
    english: &'static str,
    for_brain: &'static str,
}

const fn ex(medical: bool, english: &'static str, for_brain: &'static str) -> Example {
    Example { medical, english, for_brain }
}

// Short examples so the small model copies the shape. All of these are made up.
const EXAMPLES: &[(&str, Example)] = &[
    (
        "Hello, nice weather today. The child has had fever for three days and a cough.",
        ex(true, "The child has had fever for three days and a cough.", ""),
    ),
    (
        "Patient Sara Haddad, file number 445566, phone 0791112233, has neutropenia after chemotherapy.",
        ex(true, "The patient has neutropenia after chemotherapy.", ""),
    ),
    (
        "Patient Omar Nasser, born 2 February 2014, in room 12, has a fever.",
        ex(true, "The patient has a fever.", ""),
    ),
    (
        "عند الطفل حرارة من يومين ونقص عدلات",
        ex(true, "The child has had fever for two days and neutropenia.", ""),
    ),
    (
        "Give ceftriaxone 50 mg per kg. Did you already give the morning dose?",
        ex(
            true,
            "Ceftriaxone 50 mg per kg was ordered. Someone was asked whether the morning dose was already given.",
            "",
        ),
    ),
    ("Let's get coffee after the meeting.", ex(false, "", "")),
    (
        "Hey, what is our protocol for febrile neutropenia?",
        ex(true, "What is our protocol for febrile neutropenia?", "What is our protocol for febrile neutropenia?"),
    ),
    (
        "I need our note on vancomycin dosing.",
        ex(true, "A note on vancomycin dosing was requested.", "What is our note on vancomycin dosing?"),
    ),
];

pub fn prompt_for(text: &str) -> String {
    let examples = EXAMPLES
        .iter()
        .map(|(heard, cleaned)| format!("Heard: {heard}\n{}", serde_json::to_string(cleaned).unwrap()))
        .collect::<Vec<_>>()
        .join("\n\n");
    [
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
        &examples,
        "",
        &format!("Heard: {text}"),
    ]
    .join("\n")
}

static WOKE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(?:hey{B}|هاي|يا[{S}]*دماغي)"));
static LOOKUP: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i){B}(our note|our protocol|what did i|can you find|find our note){B}"));
static WAKE_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)^(?:hey{B}(?:[{S}]+my[{S}]+brain{B})?|هاي|يا[{S}]*دماغي)[{S},.:;!?،\-]*")
});
static TO_SOMEONE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(did you|have you|can you|could you|would you){B}"));
static LOOKUP_STRICT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i){B}(our note|our protocol|what did i|find our note){B}"));

/// The question to send to the brain.
/// GPT-OSS fills for_brain when it is sure. If it only wrote the question into english,
/// Hey at the start (or a request for a note or protocol) still counts.
pub fn question_for_brain(raw: &str, english: &str, from_model: &str) -> String {
    let woke = WOKE.is_match(js::trim(raw));
    let mut question = from_model.to_string();
    if question.is_empty() && !english.is_empty() && (woke || LOOKUP.is_match(english)) {
        question = js::trim(&WAKE_WORDS.replace(english, "")).to_string();
    }
    // "Did you give the dose?" is said to someone in the room. Only Hey, or a lookup, goes to the brain.
    if !question.is_empty() && !woke && TO_SOMEONE.is_match(&question) && !LOOKUP_STRICT.is_match(&question) {
        return String::new();
    }
    question
}

static THINK: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:<think>)(?s:.*?)(?i-u:</think>)"));

/// Drop a hidden think block if the model wrote one before the real answer.
pub fn visible_text(raw: &str) -> String {
    js::trim(&THINK.replace_all(raw, "")).to_string()
}

/// Read the JSON object, even if a bit of extra text is wrapped around it.
pub fn parse_cleaned(raw: &str) -> Result<Value, String> {
    let text = visible_text(raw);
    if let Ok(v) = serde_json::from_str(&text) {
        return Ok(v);
    }
    match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if end > start => serde_json::from_str(&text[start..=end]).map_err(|e| e.to_string()),
        _ => Err("GPT-OSS did not return JSON.".into()),
    }
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})"));
static PHONE: LazyLock<Regex> = LazyLock::new(|| re(r"{B}(?:\+?[0-9][0-9{S}().\-]{6,}[0-9]){B}"));
static LABELED_ID: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i-u:{B}(?:mrn|file number|national (?:id|number)|id number))[{S}]*[:#]?[{S}]*(?i-u:[A-Z0-9-]{3,}){B}")
});
static NUMERIC_DATE: LazyLock<Regex> = LazyLock::new(|| re(r"{B}[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}{B}"));
static MONTH_DATE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i-u:{B}(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))[{S}]+[0-9]{1,2},?[{S}]+[0-9]{4}{B}")
});
static BIRTH_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i-u:{B}(?:born|dob|date of birth){B})[:,]?[{S}]*"));
static MULTI_SPACE: LazyLock<Regex> = LazyLock::new(|| re(r"[{S}]{2,}"));
static SPACE_BEFORE_PUNCT: LazyLock<Regex> = LazyLock::new(|| re(r"[{S}]+([,.])"));

/// Drop phone numbers, emails, dates of birth, and labeled record numbers the model may have left in.
pub fn strip_obvious_ids(text: &str) -> String {
    let t = EMAIL.replace_all(text, "");
    let t = PHONE.replace_all(&t, "");
    let t = LABELED_ID.replace_all(&t, "");
    let t = NUMERIC_DATE.replace_all(&t, "");
    let t = MONTH_DATE.replace_all(&t, "");
    let t = BIRTH_LABEL.replace_all(&t, "");
    let t = MULTI_SPACE.replace_all(&t, " ");
    let t = SPACE_BEFORE_PUNCT.replace_all(&t, "${1}");
    js::trim(&t).to_string()
}

/// JS truthiness, for model output that ignored the schema.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// JS `String(v || "")` for the values a model can return.
fn js_string(v: &Value) -> String {
    match v {
        _ if !truthy(v) => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

static TWO_CAPITALIZED: LazyLock<Regex> = LazyLock::new(|| re(r"{B}[A-Z][a-z]+[{S}]+[A-Z][a-z]+{B}"));
static WRAPPING_QUOTE: LazyLock<Regex> = LazyLock::new(|| re(r#"^["']|["']$"#));

#[derive(Debug, Serialize, PartialEq)]
pub struct Cleaned {
    pub medical: bool,
    pub english: String,
    pub question: String,
    pub ms: u64,
}

pub struct Medgem {
    ollama_url: String,
    http: reqwest::Client,
}

impl Medgem {
    pub fn new(ollama_url: &str) -> Self {
        Self { ollama_url: ollama_url.to_string(), http: reqwest::Client::new() }
    }

    pub fn from_env() -> Self {
        Self::new(&std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into()))
    }

    async fn generate(&self, body: Value, timeout: Duration) -> Result<reqwest::Response, String> {
        self.http
            .post(format!("{}/api/generate", self.ollama_url))
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| e.to_string())
    }

    /// A second short pass only when two capitalized words in a row look like a person's name.
    async fn drop_names(&self, sentence: String) -> Result<String, String> {
        if !TWO_CAPITALIZED.is_match(&sentence) {
            return Ok(sentence);
        }
        let prompt = [
            "Rewrite the sentence with no person names.",
            "Say the patient instead of a name. Keep the medical facts. Do not add advice.",
            &format!("Sentence: {sentence}"),
            "Rewritten:",
        ]
        .join("\n");
        let response = self
            .generate(
                json!({
                    "model": MEDGEM_MODEL,
                    "prompt": prompt,
                    "stream": false,
                    // This model ignores "off". Low is the smallest amount of thinking it will do.
                    "think": "low",
                    "keep_alive": "30m",
                    // Thinking tokens count toward num_predict, so the cap has to be larger than the sentence.
                    "options": { "temperature": 0, "num_predict": 1600, "num_ctx": 4096 },
                }),
                Duration::from_secs(60),
            )
            .await?;
        if !response.status().is_success() {
            return Ok(sentence);
        }
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        let visible = visible_text(&js_string(&data["response"]));
        let rewritten = strip_obvious_ids(&WRAPPING_QUOTE.replace_all(&visible, ""));
        Ok(if rewritten.is_empty() { sentence } else { rewritten })
    }

    /// `text` is what the microphone heard, in any language.
    pub async fn clean_medical(&self, text: &str) -> Result<Cleaned, String> {
        let started = Instant::now();
        let response = self
            .generate(
                json!({
                    "model": MEDGEM_MODEL,
                    "prompt": prompt_for(text),
                    "stream": false,
                    // This model ignores "off". Low is the smallest amount of thinking it will do.
                    "think": "low",
                    "format": {
                        "type": "object",
                        "properties": {
                            "medical": { "type": "boolean" },
                            "english": { "type": "string" },
                            "for_brain": { "type": "string" },
                        },
                        "required": ["medical", "english", "for_brain"],
                    },
                    "keep_alive": "30m",
                    // 4096 is enough for one transcript. num_predict includes the hidden thinking.
                    "options": { "temperature": 0, "num_predict": 2000, "num_ctx": 4096 },
                }),
                // The first call loads the model. Later calls are much faster.
                Duration::from_secs(90),
            )
            .await?;
        if !response.status().is_success() {
            return Err(format!("Ollama returned {}", response.status().as_u16()));
        }
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        let parsed = parse_cleaned(&js_string(&data["response"]))?;
        let medical = truthy(&parsed["medical"]);
        let mut english = if medical { strip_obvious_ids(&js_string(&parsed["english"])) } else { String::new() };
        if !english.is_empty() {
            english = self.drop_names(english).await?;
        }
        // Hey, or a clear lookup, is a question even when the model leaves for_brain blank.
        let mut question = if medical {
            question_for_brain(text, &english, &strip_obvious_ids(&js_string(&parsed["for_brain"])))
        } else {
            String::new()
        };
        if !question.is_empty() {
            question = self.drop_names(question).await?;
        }
        let ms = started.elapsed().as_millis() as u64;
        let tokens = match &data["eval_count"] {
            Value::Null => "?".to_string(),
            v => js_string(v),
        };
        // Never log the transcript. It can name a patient.
        println!(
            "GPT-OSS medical: medical {}, question {}, {tokens} tokens, {ms} ms",
            if medical { "yes" } else { "no" },
            if question.is_empty() { "no" } else { "yes" },
        );
        Ok(Cleaned { medical: !english.is_empty() || !question.is_empty(), english, question, ms })
    }

    /// Load GPT-OSS now, so the first sentence is not waiting on a cold start.
    pub async fn warm(&self) -> Result<(), String> {
        self.generate(
            json!({
                "model": MEDGEM_MODEL,
                "prompt": "",
                "stream": false,
                "keep_alive": "30m",
                "options": { "num_ctx": 4096 },
            }),
            Duration::from_secs(90),
        )
        .await
        .map(|_| ())
    }
}
