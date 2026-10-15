//! Rust port of `second-brain/emailsearch.js`.
//!
//! "Find the email from Sara about the budget" -> lists up to three saved emails (raw/), newest first.
//! "Open number two"                            -> brings Outlook forward and searches for that subject.
//! "Open the email about the IRB renewal"       -> one clear match goes straight to Outlook.
//!
//! The saved copies in raw/ have no Outlook message ID, so Outlook is reached through its
//! search box (Command-Option-F). That needs Accessibility permission for the server once.
//! Subjects and senders are never logged (they may name patients).

use crate::openfile::{BoxFut, Files, Opener};
use crate::{js, js_re};
use chrono::{Local, TimeZone};
use serde::Serialize;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

pub const OSASCRIPT: &str = "/usr/bin/osascript";

const FILLER: &[&str] = &[
    "the", "an", "my", "from", "about", "regarding", "on", "with", "titled", "called", "that", "says", "email", "emails",
    "mail", "and", "for", "to", "of", "in", "dr", "doctor",
];
// Reading the first lines finds senders, but only for recent mail, to stay fast.
const HEAD_FILES: usize = 1500;
const HEAD_BYTES: usize = 2000;

const OUTLOOK_SEARCH: &str = r#"
on run argv
  set theQuery to item 1 of argv
  set oldClip to the clipboard
  set the clipboard to theQuery
  tell application "Microsoft Outlook" to activate
  delay 0.8
  tell application "System Events"
    keystroke "f" using {command down, option down}
    delay 0.4
    keystroke "a" using {command down}
    keystroke "v" using {command down}
    delay 0.2
    key code 36
  end tell
  delay 0.5
  set the clipboard to oldClip
end run"#;

/// One saved email file under raw/, as the server indexes it.
#[derive(Debug, Clone)]
pub struct RawMail {
    pub rel: String,
    /// File name without .txt/.md.
    pub title: String,
    pub full: String,
    pub mtime: f64,
    pub size: u64,
    pub lower_name: String,
    pub words: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub struct MailJob {
    pub query: String,
    pub open: bool,
}

#[derive(Debug, Serialize)]
pub struct Card {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MailAnswer {
    pub text: String,
    pub card: Card,
}

/// `{ query, open }` when the question asks to find or open an email, else None.
pub fn email_search_job(question: &str) -> Option<MailJob> {
    let q = js_re!(r#"^["“'\s.,]+|["”'\s]+$"#, "g").replace(js::trim(question), "");
    let find = js_re!(
        r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+)?(?:please\s+)?(find|search for|look for|locate|open|pull up|show me)\s+(?:the\s+|an\s+|my\s+|that\s+)?e-?mails?\s+((?:from|about|regarding|on|with|titled|called|that says)\s+.+?)[?.!]*$",
        "i"
    )
    .exec(&q);
    if let Some(m) = find {
        let verb = m[1].as_deref().unwrap_or("");
        return Some(MailJob {
            query: js::trim(m[2].as_deref().unwrap_or("")).into(),
            open: js_re!(r"^(?:open|pull up)$", "i").test(verb),
        });
    }
    let search = js_re!(
        r"^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+)?search\s+(?:my\s+|the\s+)?(?:e-?mails?|inbox|outlook|mail)\s+for\s+(.+?)[?.!]*$",
        "i"
    )
    .exec(&q)?;
    Some(MailJob { query: js::trim(search[1].as_deref().unwrap_or("")).into(), open: false })
}

fn terms(query: &str) -> Vec<String> {
    js_re!(r"[\p{L}\p{N}]+", "gu")
        .match_all(&query.to_lowercase())
        .into_iter()
        .filter(|w| js::len16(w) >= 3 && !FILLER.contains(&w.as_str()))
        .collect()
}

fn head(file: &str) -> String {
    let mut buf = Vec::with_capacity(HEAD_BYTES);
    match std::fs::File::open(file).and_then(|f| f.take(HEAD_BYTES as u64).read_to_end(&mut buf)) {
        Ok(_) => String::from_utf8_lossy(&buf).to_lowercase(),
        Err(_) => String::new(),
    }
}

/// Up to three saved emails whose subject (or, for recent mail, first lines) hold every word.
pub fn search_emails<'a>(query: &str, raw_mail: &'a [RawMail]) -> Vec<&'a RawMail> {
    let wanted = terms(query);
    if wanted.is_empty() {
        return Vec::new();
    }
    let has_all = |text: &str| wanted.iter().all(|w| text.contains(w.as_str()));
    let mut newest: Vec<&RawMail> = raw_mail.iter().collect();
    newest.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    let mut hits: Vec<&RawMail> = newest.iter().copied().filter(|m| has_all(&m.lower_name)).collect();
    if hits.len() < 3 {
        for &mail in newest.iter().take(HEAD_FILES) {
            if hits.len() >= 3 {
                break;
            }
            if hits.iter().any(|h| std::ptr::eq(*h, mail)) {
                continue;
            }
            if has_all(&format!("{} {}", mail.lower_name, head(&mail.full))) {
                hits.push(mail);
            }
        }
        hits.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    }
    hits.truncate(3);
    hits
}

fn subject(mail: &RawMail) -> String {
    let s = js_re!(r"_", "g").replace(&mail.title, " ");
    js::trim(&js_re!(r"\s+", "g").replace(&s, " ")).to_string()
}

/// "today", "yesterday", or "on October 15", in local time.
fn spoken_day(mtime: f64, now_ms: i64) -> String {
    let day = Local.timestamp_millis_opt(mtime as i64).unwrap();
    let midnight = |d: chrono::DateTime<Local>| {
        let local = d.date_naive().and_hms_opt(0, 0, 0).unwrap();
        Local.from_local_datetime(&local).earliest().unwrap().timestamp_millis()
    };
    let today = midnight(Local.timestamp_millis_opt(now_ms).unwrap());
    let days = ((today - midnight(day)) as f64 / 86_400_000.0).round() as i64;
    match days {
        0 => "today".into(),
        1 => "yesterday".into(),
        _ => format!("on {}", day.format("%B %-d")),
    }
}

/// Bring Outlook forward and search for the email's subject.
pub async fn open_in_outlook(mail: &RawMail, osascript: &str) -> String {
    // Drop FW / RE prefixes and keep the first words; Outlook matches them anywhere.
    let query = js_re!(r"^(?:(?:fw|fwd|re)\s*:?\s+)+", "i").replace(&subject(mail), "");
    let query = query.split(' ').take(10).collect::<Vec<_>>().join(" ");
    let child = tokio::process::Command::new(osascript)
        .args(["-e", OUTLOOK_SEARCH, &query])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let result = match tokio::time::timeout(Duration::from_secs(20), child).await {
        Err(_) => Err(format!("Command failed: {osascript} (timed out)")),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            Err(if stderr.is_empty() { format!("Command failed: {osascript}") } else { stderr })
        }
    };
    match result {
        Ok(()) => format!("I searched Outlook for {query}. It should be at the top."),
        Err(msg) => {
            let blocked = js_re!(r"assistive|not allowed|-1719|-25211|1002", "i").test(&msg);
            let first_line = msg.split('\n').next().unwrap_or("");
            eprintln!("Failed while searching Outlook: {}", if blocked { "Accessibility permission missing" } else { first_line });
            if blocked {
                "Outlook search needs one permission. Open System Settings, Privacy and Security, Accessibility, and turn on the app that runs the brain server. Then ask again.".into()
            } else {
                "I could not search Outlook. Check that Outlook is open.".into()
            }
        }
    }
}

fn answer(text: String, lines: Vec<String>) -> MailAnswer {
    MailAnswer { text, card: Card { title: "Emails".into(), lines } }
}

/// `files` holds the numbered list, so "open number two" opens that email in Outlook.
pub async fn run_email_search(
    job: &MailJob,
    raw_mail: &[RawMail],
    files: &Arc<Files>,
    osascript: &str,
    now_ms: i64,
) -> MailAnswer {
    let hits = search_emails(&job.query, raw_mail);
    println!("Email search: {} match(es)", hits.len());
    if hits.is_empty() {
        let text = format!("I could not find an email {} in your saved mail.", job.query);
        return answer(text.clone(), vec![text]);
    }
    if job.open && hits.len() == 1 {
        let text = open_in_outlook(hits[0], osascript).await;
        return answer(text.clone(), vec![text]);
    }
    let openers = hits
        .iter()
        .map(|&mail| {
            let (mail, osascript) = (mail.clone(), osascript.to_string());
            Arc::new(move || -> BoxFut<'static, String> {
                let (mail, osascript) = (mail.clone(), osascript.clone());
                Box::pin(async move { open_in_outlook(&mail, &osascript).await })
            }) as Opener
        })
        .collect();
    files.remember_list(openers);
    let lines = hits.iter().enumerate().map(|(i, m)| format!("{}. {} ({})", i + 1, subject(m), spoken_day(m.mtime, now_ms))).collect();
    let names: Vec<String> =
        hits.iter().enumerate().map(|(i, m)| format!("{}, {}, {}", i + 1, subject(m), spoken_day(m.mtime, now_ms))).collect();
    let text = format!(
        "I found {} email{}. {}. Say open number one{} to see it in Outlook.",
        hits.len(),
        if hits.len() == 1 { "" } else { "s" },
        names.join(". "),
        if hits.len() > 1 { ", two, or three" } else { "" }
    );
    answer(text, lines)
}
