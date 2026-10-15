//! Rust port of `second-brain/openfile.js`.
//!
//! "Open my todo.md file"           -> opens wiki/todo.md in its usual app on this Mac.
//! "Find the grant budget on my Mac" -> lists up to three matches from Spotlight (the Finder's search).
//! "Open number two"                 -> opens the second file from that list.
//!
//! "Open" looks in the notes first, then in Spotlight under your home folder.
//! Spotlight results skip Library, hidden folders, apps, and code folders.
//! File names are never logged (they may name patients).
//! Word files (.doc and .docx) open in LibreOffice, so you can read and edit them there.
//! The brain does not change the file itself.
//!
//! One change from the JS: "open number N" after an email list runs the email
//! list's opener. The JS stored that opener but never called it, and crashed.

use crate::js::{self, path};
use crate::js_re;
use crate::learnings::words;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Opens one item of a spoken numbered list and returns the sentence to say.
pub type Opener = Arc<dyn Fn() -> BoxFut<'static, String> + Send + Sync>;
/// Meaning search: (note rel, score) pairs, best first.
pub type MeaningFn<'a> = &'a (dyn Fn(String) -> BoxFut<'static, Result<Vec<(String, f64)>, String>> + Sync);

/// The last numbered list (files or emails), so "open number two" works for a few minutes.
const LIST_MS: Duration = Duration::from_secs(10 * 60);
// Word files open in LibreOffice. Other files still use their usual app.
const WORD_EXT: &[&str] = &[".doc", ".docx", ".docm", ".odt", ".rtf"];

pub trait NoteFile {
    /// Path relative to its notes folder.
    fn rel(&self) -> &str;
    /// Title, or "" to use the file name.
    fn title(&self) -> &str;
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenJob {
    pub name: String,
    pub explicit: bool,
}

#[derive(Default)]
pub struct Help<'a> {
    /// The whole question as asked.
    pub asked: &'a str,
    /// Recent conversation, to resolve "open the one we discussed".
    pub recent_text: &'a str,
    pub find_by_meaning: Option<MeaningFn<'a>>,
}

/// Where the outside programs are. Tests point these at fakes.
pub struct Config {
    pub home: String,
    pub mdfind: String,
    pub open: String,
    pub libreoffice: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            home: std::env::var("HOME").unwrap_or_default(),
            mdfind: "/usr/bin/mdfind".into(),
            open: "/usr/bin/open".into(),
            libreoffice: "/Applications/LibreOffice.app".into(),
        }
    }
}

enum Plan {
    Text(String),
    Full(String),
    Files(Vec<String>),
    Pick(Opener),
}

pub struct Files {
    cfg: Config,
    last_found: Mutex<(Vec<Opener>, Option<Instant>)>,
    // The last file actually opened, so "open it" still works a few minutes later.
    last_opened: Mutex<Option<(String, Instant)>>,
}

/// Squash a name so "to-do dot md", "To Do.md" and "todo" all compare equal.
pub fn compact(name: &str) -> String {
    let s = name.to_lowercase();
    let s = js_re!(r"\s+dot\s+(md|pdf|docx?)\b", "g").replace(&s, ".$1");
    let s = js_re!(r"\.(md|pdf|docx?)$", "").replace(&s, "");
    js_re!(r"[^\p{L}\p{N}]+", "gu").replace(&s, "")
}

fn strip_quotes(question: &str) -> String {
    js_re!(r#"^["“'\s.,]+|["”'\s]+$"#, "g").replace(js::trim(question), "")
}

fn is_word_ext(file: &str) -> bool {
    WORD_EXT.contains(&path::extname(file).to_lowercase().as_str())
}

fn within(at: Option<Instant>) -> bool {
    at.is_some_and(|t| t.elapsed() < LIST_MS)
}

/// `{ name, explicit }` when the question asks to open a file, else None.
pub fn open_file_job(question: &str) -> Option<OpenJob> {
    let q = strip_quotes(question);
    let m = js_re!(
        r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?(?:open|pull up|bring up|edit|read)\s+(?:up\s+)?(?:my\s+|the\s+)?(.+?)(?:\s+(file|note|document|doc|page|word file|pdf))?(?:\s+for me)?(?:\s+please)?[?.!]*$",
        "i"
    )
    .exec(&q)?;
    let said = m[1].clone().unwrap_or_default();
    // These "open" requests belong to email and the calendar.
    if js_re!(r"\b(?:e-?mails?|mail|inbox|outlook|calendar|meetings?|messages?)\b", "i").test(&said) {
        return None;
    }
    // "Read the news" is a question. "Read the protocol word document" is a file.
    let reading = js_re!(
        r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?read\b",
        "i"
    )
    .test(&q);
    if reading && !js_re!(r"\b(?:word|docx?|dot\s+docx?)\b", "i").test(&q) {
        return None;
    }
    // "protocol word document" means the file "protocol", not a file named "word".
    let mut name = js::trim(&said).to_string();
    if js_re!(r"\b(?:word\s+(?:documents?|docs?|files?)|docx?|dot\s+docx?)\b", "i").test(&q) {
        name = js_re!(r"\.(?:docx?|dot\s+docx?)\b", "gi").replace(&name, " ");
        name = js_re!(r"\b(?:word|documents?|docs?|files?|docx)\b", "gi").replace(&name, " ");
    }
    let name = js::trim(&js_re!(r"\s+", "g").replace(&name, " ")).to_string();
    if name.is_empty() {
        return None;
    }
    // "file", ".md", "dot md" say for sure that a file is meant.
    let explicit = m[2].as_deref().is_some_and(|k| !k.is_empty())
        || js_re!(r"(?:\.|\bdot\s+)(?:md|pdf|docx?)\b", "i").test(&said)
        || js_re!(r"\bword\b", "i").test(&q);
    Some(OpenJob { name, explicit })
}

/// "Find the grant budget on my Mac" -> the name, else None.
pub fn find_on_mac_job(question: &str) -> Option<String> {
    let q = strip_quotes(question);
    let m = js_re!(
        r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+)?(?:please\s+)?(?:find|search for|look for|locate|where is)\s+(?:my\s+|the\s+|a\s+)?(.+?)\s+(?:file\s+|document\s+)?(?:on|in)\s+(?:my\s+|the\s+)?(?:mac|computer|laptop|finder)[?.!]*$",
        "i"
    )
    .exec(&q)
    .or_else(|| {
        js_re!(
            r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+)?search\s+(?:my\s+|the\s+)?(?:finder|mac|computer)\s+for\s+(?:my\s+|the\s+|a\s+)?(.+?)[?.!]*$",
            "i"
        )
        .exec(&q)
    })?;
    Some(js::trim(m[1].as_deref().unwrap_or("")).to_string())
}

fn has_all(own: &[String], said: &[String]) -> bool {
    said.iter().all(|w| own.contains(w))
}

/// The full path of the note whose file name best fits what was said, or None.
pub fn find_file<N: NoteFile>(name: &str, notes: &[N], roots: &[String]) -> Option<String> {
    let wanted = compact(name);
    if wanted.is_empty() {
        return None;
    }
    let base = |note: &N| js_re!(r"\.(md|pdf|docx?)$", "i").replace(&path::basename(note.rel()), "");
    let mut pick: Vec<&N> = notes.iter().filter(|n| compact(&base(n)) == wanted).collect();
    if pick.is_empty() {
        // Every word said must be in the file name, so "zzqx report" does not open some other report.
        let said = words(&js_re!(r"\s+dot\s+\w+$", "i").replace(name, ""));
        if !said.is_empty() {
            pick = notes.iter().filter(|n| has_all(&words(&base(n)), &said)).collect();
        }
    }
    // Several todo.md files: prefer the one in wiki/, then the shortest path.
    pick.sort_by_key(|n| (!n.rel().starts_with("wiki/"), js::len16(n.rel())));
    for note in pick {
        for root in roots {
            let full = path::join(root, note.rel());
            if full.starts_with(&format!("{}{}", path::resolve(root, ""), path::SEP)) && Path::new(&full).exists() {
                return Some(full);
            }
        }
    }
    None
}

/// Full path of a note, only if it sits inside one of the selected folders.
fn note_path(rel: &str, roots: &[String]) -> Option<String> {
    roots.iter().find_map(|root| {
        let full = path::resolve(root, rel);
        let root = path::resolve(root, "");
        let inside = full == root || full.starts_with(&format!("{root}{}", path::SEP));
        (inside && Path::new(&full).exists()).then_some(full)
    })
}

/// "Grant budget, a Word file in Downloads"
fn spoken(file: &str) -> String {
    let ext = path::extname(file);
    let kind = match ext.get(1..).unwrap_or("").to_lowercase().as_str() {
        "docx" | "doc" => "a Word file",
        "pdf" => "a PDF",
        "md" => "a note",
        "xlsx" => "a spreadsheet",
        "pptx" => "a slide deck",
        _ => "a file",
    };
    format!("{}, {kind} in {}", path::basename_without(file, &ext), path::basename(&path::dirname(file)))
}

fn is_vague_name(name: &str) -> bool {
    let n = js_re!(r"[?.!]+$", "g").replace(&name.to_lowercase(), "");
    js_re!(
        r"^(?:it|that|this|one|the one|that one|this one|same one|we discussed|one we discussed|document we discussed|file we discussed|the one we discussed)$",
        "i"
    )
    .test(js::trim(&n))
}

/// Word or PDF files whose title was written out in the recent conversation.
/// An Arabic file name matches even when the user asked for it in English,
/// as long as the last answer said that Arabic name.
fn files_named_in_talk<N: NoteFile>(text: &str, notes: &[N], roots: &[String]) -> Vec<String> {
    let hay = compact(text);
    if js::len16(&hay) < 8 {
        return Vec::new();
    }
    let mut found: Vec<(String, usize)> = Vec::new();
    for note in notes {
        let ext = path::extname(note.rel()).to_lowercase();
        if !is_word_ext(note.rel()) && ext != ".pdf" {
            continue;
        }
        let title = compact(if note.title().is_empty() { path::basename(note.rel()) } else { note.title().into() }.as_str());
        if js::len16(&title) < 8 || !hay.contains(&title) {
            continue;
        }
        if let Some(full) = note_path(note.rel(), roots) {
            found.push((full, hay.rfind(&title).unwrap()));
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    let mut seen = Vec::new();
    for (full, _) in found {
        if !seen.contains(&full) {
            seen.push(full);
        }
    }
    seen
}

/// The one Word file named in the recent chat, when the user's words are in that chat too.
fn discussed_file<N: NoteFile>(name: &str, text: &str, notes: &[N], roots: &[String]) -> Option<String> {
    let named: Vec<String> = files_named_in_talk(text, notes, roots).into_iter().filter(|f| is_word_ext(f)).collect();
    if named.len() != 1 {
        return None;
    }
    let said = words(name);
    if said.is_empty() {
        return None;
    }
    has_all(&words(text), &said).then(|| named[0].clone())
}

/// English words such as "legal questions" will not be in an Arabic file name.
/// Meaning search still knows which Word file is about that subject.
/// Open it only when one Word file is clearly closer than the rest.
async fn word_file_by_meaning(name: &str, roots: &[String], find: MeaningFn<'_>) -> Option<Plan> {
    let hits = match find(name.to_string()).await {
        Ok(h) => h,
        Err(err) => {
            eprintln!("Failed while matching a Word file by meaning: {err}");
            return None;
        }
    };
    let mut ranked: Vec<(String, f64)> = Vec::new();
    for (rel, score) in hits {
        if !is_word_ext(&rel) {
            continue;
        }
        let Some(full) = note_path(&rel, roots) else { continue };
        if ranked.iter().any(|(f, _)| *f == full) {
            continue;
        }
        ranked.push((full, if score.is_nan() { 0.0 } else { score }));
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let first = ranked.first()?;
    if first.1 < 0.26 {
        return None;
    }
    let gap = ranked.get(1).map_or(1.0, |second| first.1 - second.1);
    // One Word file is clearly about this. A typo still counts when the gap stays wide.
    if (first.1 >= 0.3 && gap >= 0.05) || (first.1 >= 0.27 && gap >= 0.06) {
        return Some(Plan::Full(first.0.clone()));
    }
    Some(Plan::Files(ranked.into_iter().take(3).map(|(f, _)| f).collect()))
}

struct Hit {
    file: String,
    exact: bool,
}

async fn run(program: &str, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(timeout, child)
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Command failed: {program} {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(out.stdout)
}

impl Files {
    pub fn new(cfg: Config) -> Arc<Self> {
        Arc::new(Self { cfg, last_found: Mutex::new((Vec::new(), None)), last_opened: Mutex::new(None) })
    }

    /// Remember a numbered list; "open number N" runs the Nth opener.
    pub fn remember_list(&self, items: Vec<Opener>) {
        *self.last_found.lock().unwrap() = (items, Some(Instant::now()));
    }

    /// Files under the home folder whose names hold every word said, best first (up to three).
    async fn spotlight(&self, name: &str) -> Vec<Hit> {
        let clean = js_re!(r"\s+(?:file|document|doc|word file|pdf|presentation|spreadsheet)$", "i").replace(name, "");
        let clean = js::trim(&js_re!(r"\s+dot\s+(\w+)$", "i").replace(&clean, ".$1")).to_string();
        let said = words(&js_re!(r"\.\w+$", "").replace(&clean, ""));
        // Spotlight takes one name piece; the other words are checked below.
        let mut pieces = js_re!(r"[\p{L}\p{N}]+", "gu").match_all(&clean.to_lowercase());
        pieces.sort_by_key(|p| std::cmp::Reverse(js::len16(p)));
        let Some(longest) = pieces.first() else { return Vec::new() };
        if said.is_empty() {
            return Vec::new();
        }
        let stdout = match run(&self.cfg.mdfind, &["-onlyin", &self.cfg.home, "-name", longest], Duration::from_secs(10)).await {
            Ok(out) if out.len() <= 16 * 1024 * 1024 => String::from_utf8_lossy(&out).into_owned(),
            Ok(_) => {
                eprintln!("Failed while searching Spotlight: stdout maxBuffer length exceeded");
                return Vec::new();
            }
            Err(err) => {
                eprintln!("Failed while searching Spotlight: {err}");
                return Vec::new();
            }
        };
        let wanted = compact(&clean);
        let skip = js_re!(r"\/(?:Library|node_modules|\.[^/]+|[^/]+\.app|tmp|venv|site-packages)\/", "");
        let mut found: Vec<(Hit, f64)> = stdout
            .split('\n')
            .filter(|f| !f.is_empty() && !skip.test(f))
            .filter_map(|file| {
                let meta = std::fs::metadata(file).ok().filter(|m| m.is_file())?;
                let own = words(&js_re!(r"\.\w+$", "").replace(&path::basename(file), ""));
                if !has_all(&own, &said) {
                    return None;
                }
                let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
                let exact = compact(&path::basename(file)) == wanted;
                Some((Hit { file: file.to_string(), exact }, mtime))
            })
            .collect();
        found.sort_by(|(a, am), (b, bm)| b.exact.cmp(&a.exact).then(bm.total_cmp(am)));
        found.into_iter().take(3).map(|(h, _)| h).collect()
    }

    /// Open a file. Word files go to LibreOffice so they can be read and edited.
    async fn open_path(&self, full: &str) -> Result<(), String> {
        let word = is_word_ext(full);
        if word && !Path::new(&self.cfg.libreoffice).exists() {
            return Err("LibreOffice is not installed.".into());
        }
        let args: Vec<&str> = if word { vec!["-a", &self.cfg.libreoffice, full] } else { vec![full] };
        run(&self.cfg.open, &args, Duration::from_secs(20)).await.map(|_| ())
    }

    async fn open_and_say(&self, full: &str) -> String {
        let word = is_word_ext(full);
        match self.open_path(full).await {
            Ok(()) => {
                *self.last_opened.lock().unwrap() = Some((full.to_string(), Instant::now()));
                let spoken_name = js_re!(r"[_]+", "g").replace(&path::basename_without(full, &path::extname(full)), " ");
                if word {
                    format!("I opened {spoken_name} in LibreOffice. You can read it and edit it there. The Word file itself is not changed until you save.")
                } else {
                    format!("I opened {spoken_name}.")
                }
            }
            Err(err) => {
                eprintln!("Failed while opening a file for the user: {err}");
                if word && !Path::new(&self.cfg.libreoffice).exists() {
                    return format!(
                        "I found {}, but LibreOffice is not installed, so I could not open that Word file.",
                        path::basename(full)
                    );
                }
                format!("I found {} but could not open it.", path::basename(full))
            }
        }
    }

    fn list_sentence(self: &Arc<Self>, files: &[String]) -> String {
        let openers = files
            .iter()
            .map(|file| {
                let (me, file) = (self.clone(), file.clone());
                Arc::new(move || -> BoxFut<'static, String> {
                    let (me, file) = (me.clone(), file.clone());
                    Box::pin(async move { me.open_and_say(&file).await })
                }) as Opener
            })
            .collect();
        self.remember_list(openers);
        let names: Vec<String> = files.iter().enumerate().map(|(i, f)| format!("{}, {}", i + 1, spoken(f))).collect();
        format!(
            "I found {} file{}. {}. Say open number one, two, or three.",
            files.len(),
            if files.len() == 1 { "" } else { "s" },
            names.join(". ")
        )
    }

    pub async fn run_find_on_mac(self: &Arc<Self>, name: &str) -> String {
        let hits = self.spotlight(name).await;
        println!("Spotlight search: {} match(es)", hits.len());
        if hits.is_empty() {
            let kinds = js_re!(r"\s+(?:file|document|doc|word file|pdf|presentation|spreadsheet)$", "i");
            return format!("I could not find a file called {} on your Mac.", kinds.replace(name, ""));
        }
        self.list_sentence(&hits.into_iter().map(|h| h.file).collect::<Vec<_>>())
    }

    /// Decide which file to open. Does not open it.
    async fn plan_open<N: NoteFile>(&self, job: &OpenJob, notes: &[N], roots: &[String], help: &Help<'_>) -> Option<Plan> {
        let pick = js_re!(r"^(?:number\s+|the\s+)?(one|two|three|1|2|3|first|second|third)(?:\s+one)?$", "i").exec(&job.name);
        if let Some(pick) = pick {
            let (items, at) = &*self.last_found.lock().unwrap();
            if within(*at) {
                let index = match pick[1].as_deref().unwrap_or("").to_lowercase().as_str() {
                    "one" | "1" | "first" => 0,
                    "two" | "2" | "second" => 1,
                    _ => 2,
                };
                return Some(match items.get(index) {
                    Some(open) => Plan::Pick(open.clone()),
                    None => Plan::Text(format!("The last list has only {}.", items.len())),
                });
            }
        }
        if let Some(full) = find_file(&job.name, notes, roots) {
            return Some(Plan::Full(full));
        }
        if let Some(full) = discussed_file(&job.name, help.recent_text, notes, roots) {
            return Some(Plan::Full(full));
        }
        if is_vague_name(&job.name) {
            let mut named = files_named_in_talk(help.recent_text, notes, roots);
            if js_re!(r"\bword\b", "i").test(help.asked) {
                named.retain(|f| is_word_ext(f));
            }
            if named.len() == 1 {
                return Some(Plan::Full(named.remove(0)));
            }
            if named.len() > 1 {
                named.truncate(3);
                return Some(Plan::Files(named));
            }
            if let Some((full, at)) = self.last_opened.lock().unwrap().clone() {
                if within(Some(at)) && Path::new(&full).exists() {
                    return Some(Plan::Full(full));
                }
            }
            return Some(Plan::Text(
                "I don't know which file you mean yet. Say open, then the name, or what the document is about.".into(),
            ));
        }
        if js_re!(r"\b(?:word|docx?)\b", "i").test(help.asked) {
            if let Some(find) = help.find_by_meaning {
                return word_file_by_meaning(&job.name, roots, find).await;
            }
        }
        None
    }

    /// Open the file in its usual app and return the sentence to say back, or None to answer normally.
    pub async fn run_open_file<N: NoteFile>(
        self: &Arc<Self>,
        job: &OpenJob,
        notes: &[N],
        roots: &[String],
        help: &Help<'_>,
    ) -> Option<String> {
        match self.plan_open(job, notes, roots, help).await {
            Some(Plan::Text(text)) => return Some(text),
            Some(Plan::Full(full)) => return Some(self.open_and_say(&full).await),
            Some(Plan::Pick(open)) => return Some(open().await),
            Some(Plan::Files(files)) if files.len() == 1 => return Some(self.open_and_say(&files[0]).await),
            Some(Plan::Files(files)) if !files.is_empty() => return Some(self.list_sentence(&files)),
            _ => {}
        }
        // Not in the notes: try the whole Mac. One clear match opens; several are listed.
        let hits = self.spotlight(&job.name).await;
        println!("Spotlight search for open: {} match(es)", hits.len());
        let one_clear = hits.len() == 1 || (hits.first().is_some_and(|h| h.exact) && !hits.get(1).is_some_and(|h| h.exact));
        if one_clear {
            return Some(self.open_and_say(&hits[0].file).await);
        }
        if !hits.is_empty() {
            return Some(self.list_sentence(&hits.into_iter().map(|h| h.file).collect::<Vec<_>>()));
        }
        job.explicit.then(|| format!("I could not find a file called {} in your notes or on your Mac.", job.name))
    }
}
