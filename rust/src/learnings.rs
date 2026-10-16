//! Rust port of `second-brain/learnings.js`.
//!
//! Learnings: short facts and preferences the user asks the brain to keep.
//!
//! "Learn that Dr Khaled leads the AML protocol"   -> adds a line
//! "From now on, keep answers under three sentences" -> adds a line
//! "Forget that Dr Khaled leads the AML protocol"   -> removes the closest line
//! "What have you learned about me?"                -> lists them
//!
//! The Node app stores them in ~/.brain/memories.md (one "- " line each).
//! and go into every answer's prompt, so they last across calls.
//! Chat memory, by contrast, is cleared when a call ends.

use crate::{js, js_re};
use serde::Serialize;
use std::path::PathBuf;

// Enough for a page of preferences without crowding out the notes.
const MAX_LINES: usize = 40;
const MAX_CHARS: usize = 3000;

// Words that say what to forget, not which one.
const FILLER: &[&str] = &[
    "the", "a", "an", "my", "that", "this", "about", "memo", "memos", "note", "learning", "rule", "one", "thing", "on",
    "of", "to",
];

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LearningJob {
    List,
    Forget { text: String },
    Add { text: String },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Shortcut {
    pub name: String,
    pub url: String,
}

pub fn learning_job(question: &str) -> Option<LearningJob> {
    let q = js_re!(r"[.!]+$", "").replace(js::trim(question), "");
    if js_re!(
        r"\b(?:what (?:have you|did you) (?:learn(?:ed|t)|remember(?:ed)?)|what do you (?:know about me|remember)|what (?:are|is) (?:your|my) memor(?:y|ies)|(?:list|read|show)(?: me)? (?:your|my|the) (?:learnings|memories))\b",
        "i"
    )
    .test(&q)
    {
        return Some(LearningJob::List);
    }
    let group1 = |m: Vec<Option<String>>| js::trim(m[1].as_deref().unwrap_or("")).to_string();
    if let Some(m) = js_re!(r"^(?:please\s+)?(?:forget|unlearn|stop remembering)\s+(?:that\s+|about\s+)?(.+)$", "i").exec(&q) {
        return Some(LearningJob::Forget { text: group1(m) });
    }
    let add = js_re!(r"^(?:please\s+)?(?:(?:learn|keep in mind|bear in mind)\s+(?:that\s+)?|from now on,?\s+)(.+)$", "i")
        .exec(&q)
        // "Remember: do not be lazy" is a rule for the brain, not a memo. Memos are facts ("remember that Sara owes me slides").
        .or_else(|| {
            js_re!(
                r"^(?:please\s+)?remember[:,]?\s+(?:that\s+|to\s+)?((?:do not|don't|never|always|call me|i prefer|i like|i want|you should|answer|keep|be|use|speak|reply)\b.+)$",
                "i"
            )
            .exec(&q)
        })?;
    Some(LearningJob::Add { text: group1(add) })
}

/// Content words, cut to 4 letters so "laziness" meets "lazy" and "meetings" meets "meeting".
/// Unique, in first-seen order (a JS Set).
pub fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in js_re!(r"[\p{L}\p{N}]+", "gu").match_all(&text.to_lowercase()) {
        if FILLER.contains(&w.as_str()) {
            continue;
        }
        let cut = js::slice16(&w, 0, js::len16(&w).min(4));
        let word = js_re!(r"y$", "").replace(&cut, "i");
        if !out.contains(&word) {
            out.push(word);
        }
    }
    out
}

/// Index of the text that shares the most words with what was said, or None when none shares half.
pub fn closest_index<S: AsRef<str>>(said: &str, texts: &[S]) -> Option<usize> {
    let wanted = words(said);
    let mut best = None;
    let mut best_share = 0.0;
    for (index, text) in texts.iter().enumerate() {
        let own = words(text.as_ref());
        let share = wanted.iter().filter(|w| own.contains(w)).count() as f64 / wanted.len().max(1) as f64;
        if share > best_share {
            (best, best_share) = (Some(index), share);
        }
    }
    if best_share >= 0.5 {
        best
    } else {
        None
    }
}

/// True when the spoken words are that saved place, including a misheard iNotes.
fn same_place(said: &str, name: &str) -> bool {
    let heard = js_re!(r"[^a-z0-9]", "g").replace(&said.to_lowercase(), "");
    let wanted = js_re!(r"[^a-z0-9]", "g").replace(&name.to_lowercase(), "");
    if heard.is_empty() || wanted.is_empty() {
        return false;
    }
    heard == wanted || (wanted == "inotes" && js_re!(r"^(?:ions?|ionotes?|inote|eyenotes|ainotes)$", "").test(&heard))
}

pub struct Learnings {
    file: PathBuf,
}

impl Learnings {
    /// `file` is the memories file. Node uses ~/.brain/memories.md.
    pub fn new(file: PathBuf) -> Self {
        Self { file }
    }

    fn read_lines(&self) -> Vec<String> {
        match std::fs::read_to_string(&self.file) {
            Ok(text) => text.split('\n').filter_map(|l| l.strip_prefix("- ")).map(|l| js::trim(l).to_string()).collect(),
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Failed while reading memories.md: {err}");
                }
                Vec::new()
            }
        }
    }

    fn write_lines(&self, lines: &[String]) -> std::io::Result<()> {
        let body = lines.iter().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n");
        std::fs::write(&self.file, format!("# Learnings\n\nThings the user asked the second brain to keep in mind.\n\n{body}\n"))
    }

    /// Do what the request asks and return the sentence to say back.
    /// A list with nothing in it gives "" (as Node does); a forget with no match gives None.
    pub fn run(&self, job: &LearningJob) -> std::io::Result<Option<String>> {
        let lines = self.read_lines();
        let text = match job {
            LearningJob::List => {
                if lines.is_empty() {
                    return Ok(Some(String::new()));
                }
                let said: Vec<String> = lines.iter().map(|l| js_re!(r"[.]?$", "").replace(l, ".")).collect();
                let s = if lines.len() == 1 { "" } else { "s" };
                return Ok(Some(format!("I keep {} thing{s} in mind. {}", lines.len(), said.join(" "))));
            }
            LearningJob::Add { text } | LearningJob::Forget { text } => {
                let mut chars = text.chars();
                chars.next().map_or(String::new(), |c| c.to_uppercase().chain(chars).collect())
            }
        };
        if let LearningJob::Add { .. } = job {
            let mut kept: Vec<String> = lines.into_iter().filter(|l| l.to_lowercase() != text.to_lowercase()).collect();
            kept.push(text.clone());
            self.write_lines(&kept)?;
            return Ok(Some(format!("Got it. I will keep in mind: {text}")));
        }
        // Forget the line that shares the most words with what was said.
        let Some(best) = closest_index(&text, &lines) else { return Ok(None) };
        let mut kept = lines;
        let removed = kept.remove(best);
        self.write_lines(&kept)?;
        Ok(Some(format!("Done. I forgot: {removed}")))
    }

    /// A saved rule can name a place, such as "when I ask you to go to inotes, open this site".
    /// "Go to inotes" then opens that site. Whisper sometimes hears iNotes as "ions".
    fn place_shortcuts(&self) -> Vec<Shortcut> {
        let mut found: Vec<Shortcut> = Vec::new();
        for line in self.read_lines() {
            let url = js_re!(r"https?:\/\/[^\s)]+", "i").exec(&line);
            let place = js_re!(r"\bgo to\s+([a-z0-9][a-z0-9 .'-]{0,40}?)(?:\s+(?:go|open|and|then|at|on)\b|,)", "i").exec(&line);
            let (Some(url), Some(place)) = (url, place) else { continue };
            let name = js::trim(place[1].as_deref().unwrap_or("")).to_string();
            if name.is_empty() || js_re!(r"^(?:this|the|that|my|a|an)$", "i").test(&name) {
                continue;
            }
            let url = js_re!(r"[.,]+$", "").replace(url[0].as_deref().unwrap_or(""), "");
            if !found.iter().any(|f| f.name.to_lowercase() == name.to_lowercase() && f.url == url) {
                found.push(Shortcut { name, url });
            }
        }
        found
    }

    /// `{ name, url }` when the question asks to open a saved place, else None.
    pub fn site_shortcut(&self, question: &str) -> Option<Shortcut> {
        let q = js_re!(r"[.!?]+$", "g").replace(js::trim(question), "");
        let m = js_re!(
            r"^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:please\s+)?(?:go to|open|show(?:\s+me)?|pull up|bring up|take me to|launch)\s+(?:the\s+)?(?:site\s+|page\s+|app\s+|website\s+)?(.+)$",
            "i"
        )
        .exec(&q)?;
        let said = js_re!(r"\b(?:site|page|app|website|please|now)\b", "gi").replace(m[1].as_deref().unwrap_or(""), " ");
        let said = js::trim(&js_re!(r"\s+", "g").replace(&said, " ")).to_string();
        if said.is_empty() || js_re!(r"https?:\/\/|(?:[a-z0-9-]+\.)+(?:com|org|net|io|gov|edu)", "i").test(&said) {
            return None;
        }
        self.place_shortcuts().into_iter().find(|s| same_place(&said, &s.name))
    }

    /// The prompt block, newest first, within the size limits.
    pub fn block(&self) -> String {
        let mut kept = Vec::new();
        let mut size = 0;
        for line in self.read_lines().iter().rev().take(MAX_LINES) {
            size += js::len16(line);
            if size > MAX_CHARS {
                break;
            }
            kept.push(format!("- {line}"));
        }
        if kept.is_empty() {
            String::new()
        } else {
            format!("Things the user asked you to always keep in mind:\n{}", kept.join("\n"))
        }
    }
}
