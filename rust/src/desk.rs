//! Rust port of `second-brain/desk.js`.
//!
//! The desk is the work that should still be here after a restart.
//!
//! It is one private file, desk.json, next to server.js. The git repo
//! ignores it. Three kinds of things live in it:
//!   jobs         a page to watch, a reminder, a repeating job, or a draft waiting for "send it"
//!   suggestions  short ideas (reply to a recent email) you can do or skip
//!   memory       the last voice conversation, so the next call can continue it
//!
//! This file only stores and understands those things. Opening Outlook,
//! texting the phone, and reading a web page happen in the server.
//!
//! Jobs stay plain JSON objects (key order kept), so the file Rust writes is
//! byte-for-byte what Node writes, and fields Rust does not know survive.

use crate::{js, js_re};
use chrono::{DateTime, Datelike, Duration as Days, Local, LocalResult, NaiveDateTime, NaiveTime, Offset, TimeZone, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_WATCHES: usize = 8;
const MAX_SCHEDULES: usize = 8;
const MAX_SUGGESTIONS: usize = 4;
const MAX_JOBS: usize = 40;
const DAY_WORDS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

struct State {
    jobs: Vec<Value>,
    suggestions: Vec<Value>,
    dismissed: Vec<Value>,
    summary: String,
    turns: Vec<Value>,
    saved_at: String,
}

impl State {
    fn empty() -> Self {
        Self { jobs: vec![], suggestions: vec![], dismissed: vec![], summary: String::new(), turns: vec![], saved_at: String::new() }
    }

    fn to_json(&self) -> Value {
        json!({
            "jobs": self.jobs,
            "suggestions": self.suggestions,
            "dismissed": self.dismissed,
            "memory": { "summary": self.summary, "turns": self.turns, "savedAt": self.saved_at },
        })
    }
}

/// A field as a string ("" when missing or not a string).
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn is_open(job: &Value) -> bool {
    matches!(s(job, "status"), "waiting" | "paused" | "needs-you" | "alerted")
}

fn is_active_watch(job: &Value) -> bool {
    s(job, "kind") == "watch" && matches!(s(job, "status"), "waiting" | "alerted")
}

/// Set fields on a job (ignored if the stored job is not an object).
fn set(job: &mut Value, fields: Value) {
    if let (Some(obj), Value::Object(fields)) = (job.as_object_mut(), fields) {
        for (k, v) in fields {
            obj.insert(k, v);
        }
    }
}

/// JS `String(value || "").replace(/\s+/g, " ").trim().slice(0, max)`.
fn clip(value: &str, max: usize) -> String {
    js::slice16(js::trim(&js_re!(r"\s+", "g").replace(value, " ")), 0, max)
}

/// A JS number: integers print without ".0", like JSON.stringify.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// JS `value || ""` for a field shown in the page.
fn or_empty(v: &Value) -> Value {
    if js::truthy(v) {
        v.clone()
    } else {
        json!("")
    }
}

/// "reply" when a draft answers a message, "draft" when it is a new email, otherwise blank.
fn email_about(job: &Value) -> &'static str {
    if s(job, "kind") != "draft" || s(&job["draft"], "type") != "email" {
        return "";
    }
    if js::trim(&js::to_str(&job["draft"]["original"])).is_empty() {
        "draft"
    } else {
        "reply"
    }
}

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Said {
    pub ok: bool,
    pub text: String,
}

#[derive(Default)]
pub struct EmailDraft<'a> {
    pub to: &'a str,
    pub name: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub original: &'a str,
}

pub enum MeetingDate {
    At(i64),
    Text(String),
}

pub struct MeetingPlan {
    pub subject: String,
    pub body: String,
    pub location: String,
    pub who: String,
    pub duration: f64,
    pub date: MeetingDate,
    pub assumed_day: bool,
    pub assumed_time: bool,
}

pub struct Suggestion {
    pub key: String,
    pub title: String,
    pub source: String,
    pub detail: String,
    /// When the email arrived (ms since 1970), for the card's numeric date.
    pub at: Option<f64>,
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type Ids = Box<dyn Fn() -> String + Send + Sync>;

pub struct Desk {
    file: PathBuf,
    state: Mutex<State>,
    now_ms: Clock,
    new_id: Ids,
}

impl Desk {
    pub fn open(file: PathBuf) -> Self {
        let id = || {
            let mut b = [0u8; 4];
            getrandom::fill(&mut b).expect("random id");
            hex::encode(b)
        };
        Self::open_with(file, Box::new(|| Utc::now().timestamp_millis()), Box::new(id))
    }

    /// For tests: a fixed clock and predictable ids.
    pub fn open_with(file: PathBuf, now_ms: Clock, new_id: Ids) -> Self {
        let state = Mutex::new(load(&file));
        Self { file, state, now_ms, new_id }
    }

    fn now_iso(&self) -> String {
        iso((self.now_ms)())
    }

    fn save(&self, state: &State) {
        let mut tmp = self.file.clone().into_os_string();
        tmp.push(".tmp");
        let text = serde_json::to_string_pretty(&state.to_json()).unwrap();
        if let Err(err) = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &self.file)) {
            eprintln!("Failed while saving desk.json: {err}");
        }
    }

    /// Drop finished jobs when the file gets long. Waiting work always stays.
    fn trim_jobs(state: &mut State) {
        let (keep, done): (Vec<Value>, Vec<Value>) = state.jobs.drain(..).partition(is_open);
        let skip = done.len().saturating_sub(MAX_JOBS);
        state.jobs = keep.into_iter().chain(done.into_iter().skip(skip)).collect();
    }

    fn push_job(&self, state: &mut State, job: Value) -> Value {
        let now = self.now_iso();
        let mut saved = Map::new();
        saved.insert("id".into(), json!((self.new_id)()));
        saved.insert("created".into(), json!(now));
        saved.insert("updated".into(), json!(now));
        saved.insert("receipt".into(), json!(""));
        if let Value::Object(fields) = job {
            for (k, v) in fields {
                saved.insert(k, v);
            }
        }
        let saved = Value::Object(saved);
        state.jobs.push(saved.clone());
        Self::trim_jobs(state);
        self.save(state);
        saved
    }

    /// Email drafts and reply ideas that still need a short summary.
    /// The server fills these with Haiku, then stores the result.
    pub fn pending_summaries(&self) -> Vec<Value> {
        let state = self.state.lock().unwrap();
        let mut tasks = Vec::new();
        for job in &state.jobs {
            if s(job, "status") != "needs-you" || email_about(job).is_empty() || js::truthy(&job["summary"]) {
                continue;
            }
            let original = js::trim(&js::to_str(&job["draft"]["original"])).to_string();
            let body = js::trim(&js::to_str(&job["draft"]["body"])).to_string();
            let text = js::slice16(if original.is_empty() { &body } else { &original }, 0, 3500);
            if text.is_empty() {
                continue;
            }
            tasks.push(json!({ "kind": "job", "id": job["id"], "about": email_about(job), "text": text, "fallback": "" }));
        }
        for item in &state.suggestions {
            // A summary that is only the title, or still starts with "Subject:", was not written by Haiku yet.
            let summary = &item["summary"];
            if js::truthy(summary) && *summary != item["title"] && !js_re!(r"^subject:", "i").test(&js::to_str(summary)) {
                continue;
            }
            tasks.push(json!({
                "kind": "suggestion",
                "id": item["id"],
                "key": item["key"],
                "about": "reply",
                "text": "",
                "fallback": or_empty(&item["title"]),
            }));
        }
        tasks
    }

    /// Save the short note Haiku wrote for one work card.
    pub fn remember_summary(&self, kind: &str, id: &str, summary: &str) -> bool {
        let text = clip(summary, 420);
        if text.is_empty() {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let list = match kind {
            "job" => &mut state.jobs,
            "suggestion" => &mut state.suggestions,
            _ => return false,
        };
        let Some(entry) = list.iter_mut().find(|e| e["id"] == id) else { return false };
        if entry["summary"] == text.as_str() {
            return false;
        }
        if kind == "job" {
            set(entry, json!({ "summary": text, "updated": now }));
        } else {
            set(entry, json!({ "summary": text }));
        }
        self.save(&state);
        true
    }

    /// A newer draft replaces the one that was still waiting.
    fn retire_drafts(&self, state: &mut State, kind: &str) {
        let now = self.now_iso();
        for job in &mut state.jobs {
            if s(job, "kind") == "draft" && s(job, "status") == "needs-you" && s(&job["draft"], "type") == kind {
                set(job, json!({ "status": "skipped", "receipt": "Replaced by a newer draft.", "updated": now }));
            }
        }
    }

    pub fn public_desk(&self) -> Value {
        let state = self.state.lock().unwrap();
        // Fields copied as-is are left out when missing, as JSON.stringify drops undefined.
        let copy = |from: &Value, keys: &[&str]| -> Map<String, Value> {
            keys.iter().filter_map(|k| from.get(*k).map(|v| (k.to_string(), v.clone()))).collect()
        };
        let jobs: Vec<Value> = state
            .jobs
            .iter()
            .filter(|j| is_open(j))
            .map(|job| {
                let mut m = copy(job, &["id", "kind", "status", "title", "detail", "receipt"]);
                m.insert("url".into(), or_empty(&job["url"]));
                m.insert("draftType".into(), or_empty(&job["draft"]["type"]));
                // For an email draft: a short note about the message being answered.
                m.insert("summary".into(), or_empty(&job["summary"]));
                m.insert("about".into(), json!(email_about(job)));
                Value::Object(m)
            })
            .collect();
        let suggestions: Vec<Value> = state
            .suggestions
            .iter()
            .map(|item| {
                let mut m = copy(item, &["id", "title", "source", "detail"]);
                m.insert("at".into(), if js::truthy(&item["at"]) { item["at"].clone() } else { json!(0) });
                // Short note about the email this idea would answer. Empty until Haiku writes it.
                m.insert("summary".into(), or_empty(&item["summary"]));
                m.insert("about".into(), json!("reply"));
                Value::Object(m)
            })
            .collect();
        let last_question = state.turns.last().map_or(json!(""), |t| or_empty(&t["question"]));
        json!({
            "jobs": jobs,
            "suggestions": suggestions,
            "memory": {
                "summary": state.summary,
                "savedAt": state.saved_at,
                "lastQuestion": last_question,
                "turns": state.turns,
            },
        })
    }

    pub fn saved_chat(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({ "summary": state.summary, "turns": state.turns })
    }

    /// `turns` is what the page sent: [{ question, answer }, ...].
    pub fn remember_chat(&self, summary: &Value, turns: &Value) {
        let turns = turns.as_array().map(|a| &a[a.len().saturating_sub(6)..]).unwrap_or(&[]);
        let turns: Vec<Value> = turns
            .iter()
            .map(|turn| {
                let answer = clip(&js::to_str(&turn["answer"]), 1500);
                json!({
                    "question": clip(&js::to_str(&turn["question"]), 500),
                    "answer": if answer.is_empty() { "(no answer yet)".to_string() } else { answer },
                })
            })
            .filter(|t| t["question"] != "")
            .collect();
        let mut state = self.state.lock().unwrap();
        state.summary = clip(&js::to_str(summary), 2000);
        state.turns = turns;
        state.saved_at = self.now_iso();
        self.save(&state);
    }

    pub fn forget_chat(&self) {
        let mut state = self.state.lock().unwrap();
        state.summary.clear();
        state.turns.clear();
        state.saved_at.clear();
        self.save(&state);
    }

    pub fn save_email_draft(&self, d: &EmailDraft) -> Option<Value> {
        let letter = js::trim(d.body);
        if letter.is_empty() {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        self.retire_drafts(&mut state, "email");
        let title = clip(d.subject, 180);
        let subject = clip(d.subject, 200);
        Some(self.push_job(
            &mut state,
            json!({
                "kind": "draft",
                "status": "needs-you",
                "title": if title.is_empty() { "Email draft".into() } else { title },
                "detail": "Say send it to open this in Outlook, or don't to drop it. Nothing is sent until you press Send.",
                "draft": {
                    "type": "email",
                    "to": clip(d.to, 200),
                    "name": clip(d.name, 80),
                    "subject": if subject.is_empty() { "Note".into() } else { subject },
                    "body": js::slice16(letter, 0, 20000),
                    "original": js::slice16(d.original, 0, 8000),
                },
            }),
        ))
    }

    pub fn save_meeting_draft(&self, plan: &MeetingPlan, detail: &str) -> Value {
        let mut state = self.state.lock().unwrap();
        self.retire_drafts(&mut state, "meeting");
        let subject = clip(&plan.subject, 180);
        let subject = if subject.is_empty() { "Meeting".to_string() } else { subject };
        let duration = if plan.duration.is_nan() || plan.duration == 0.0 { 60.0 } else { plan.duration };
        let date = match &plan.date {
            MeetingDate::At(ms) => iso(*ms),
            MeetingDate::Text(t) => t.clone(),
        };
        self.push_job(
            &mut state,
            json!({
                "kind": "draft",
                "status": "needs-you",
                "title": subject,
                "detail": clip(detail, 400),
                "draft": {
                    "type": "meeting",
                    "subject": subject,
                    "body": clip(&plan.body, 1000),
                    "location": clip(&plan.location, 120),
                    "who": clip(&plan.who, 120),
                    "duration": number(duration),
                    "date": date,
                    "assumedDay": plan.assumed_day,
                    "assumedTime": plan.assumed_time,
                },
            }),
        )
    }

    pub fn latest_draft(&self) -> Option<Value> {
        let state = self.state.lock().unwrap();
        state.jobs.iter().rev().find(|j| s(j, "kind") == "draft" && s(j, "status") == "needs-you").cloned()
    }

    pub fn job_by_id(&self, id: &str) -> Option<Value> {
        self.state.lock().unwrap().jobs.iter().find(|j| j["id"] == id).cloned()
    }

    pub fn finish_job(&self, id: &str, status: &str, receipt: &str) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let job = state.jobs.iter_mut().find(|j| j["id"] == id)?;
        set(job, json!({ "status": status, "receipt": clip(receipt, 300), "updated": now }));
        let job = job.clone();
        self.save(&state);
        Some(job)
    }

    /// Mark the email draft that Outlook just opened, so the card goes away.
    pub fn finish_latest_email(&self, receipt: &str) -> Option<Value> {
        let id = {
            let state = self.state.lock().unwrap();
            let job = state.jobs.iter().rev().find(|j| {
                s(j, "kind") == "draft" && s(j, "status") == "needs-you" && s(&j["draft"], "type") == "email"
            })?;
            s(job, "id").to_string()
        };
        self.finish_job(&id, "done", receipt)
    }

    pub fn add_watch(&self, url: &str, title: &str) -> Said {
        let parsed = match url::Url::parse(url) {
            Ok(u) => u,
            Err(err) => {
                eprintln!("Failed while reading a watch address: {err}");
                return Said { ok: false, text: "That does not look like a web address.".into() };
            }
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Said { ok: false, text: "I can only watch a normal web page, starting with https.".into() };
        }
        let href = parsed.as_str();
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let name = clip(title, 120);
        let name = if name.is_empty() { parsed.host_str().unwrap_or("").to_string() } else { name };
        if let Some(existing) = state.jobs.iter_mut().find(|j| is_active_watch(j) && j["url"] == href) {
            set(
                existing,
                json!({
                    "title": name,
                    "status": "waiting",
                    "lastText": "",
                    "receipt": "Watching again from a fresh copy of the page.",
                    "updated": now,
                }),
            );
            self.save(&state);
            return Said { ok: true, text: format!("I am watching {name} again. I will text you if the page changes.") };
        }
        if state.jobs.iter().filter(|j| is_active_watch(j)).count() >= MAX_WATCHES {
            return Said {
                ok: false,
                text: "You already have 8 pages being watched. Say stop watching, then add a new one.".into(),
            };
        }
        self.push_job(
            &mut state,
            json!({
                "kind": "watch",
                "status": "waiting",
                "title": name,
                "detail": "I will text you if this page changes.",
                "url": href,
                "lastText": "",
                "receipt": "Not checked yet.",
            }),
        );
        Said {
            ok: true,
            text: format!("I am watching {name}. I will text you if the page changes. The first check only learns what the page says now."),
        }
    }

    pub fn watches_to_check(&self) -> Vec<Value> {
        self.state.lock().unwrap().jobs.iter().filter(|j| is_active_watch(j)).cloned().collect()
    }

    /// Remember what the page says. Returns the job when the words changed.
    /// A watch stopped while its page was loading stays stopped.
    pub fn record_watch(&self, id: &str, hash: &str, error_text: &str) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let job = state.jobs.iter_mut().find(|j| j["id"] == id && is_active_watch(j))?;
        set(job, json!({ "updated": now }));
        let changed = if !error_text.is_empty() {
            set(job, json!({ "receipt": clip(error_text, 200) }));
            false
        } else if !js::truthy(&job["lastText"]) {
            set(job, json!({ "lastText": hash, "receipt": "Watching. I will text you if this page changes.", "status": "waiting" }));
            false
        } else if job["lastText"] == hash {
            set(job, json!({ "receipt": "No change since the last check." }));
            false
        } else {
            set(job, json!({ "lastText": hash, "status": "alerted", "receipt": "This page changed." }));
            true
        };
        let job = changed.then(|| job.clone());
        self.save(&state);
        job
    }

    /// Mark matching jobs and save once if any changed.
    fn mark_all(&self, matches: impl Fn(&Value) -> bool, status: &str, receipt: &str) -> usize {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let mut count = 0;
        for job in state.jobs.iter_mut().filter(|j| matches(j)) {
            set(job, json!({ "status": status, "receipt": receipt, "updated": now }));
            count += 1;
        }
        if count > 0 {
            self.save(&state);
        }
        count
    }

    pub fn cancel_watches(&self) -> usize {
        self.mark_all(is_active_watch, "skipped", "You asked me to stop watching.")
    }

    pub fn clear_alerts(&self) -> usize {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let mut count = 0;
        for job in state.jobs.iter_mut().filter(|j| s(j, "status") == "alerted") {
            // An email or meeting watch keeps going. A web page watch is finished.
            let status = if js::truthy(&job["watch"]["type"]) { "waiting" } else { "done" };
            set(job, json!({ "status": status, "receipt": "You dismissed this alert.", "updated": now }));
            count += 1;
        }
        if count > 0 {
            self.save(&state);
        }
        count
    }

    /// A watch that is not a web page. type is "mail" or "meeting". False when there are 8 already.
    fn add_standing_watch(&self, state: &mut State, job: Value) -> bool {
        if state.jobs.iter().filter(|j| is_active_watch(j)).count() >= MAX_WATCHES {
            return false;
        }
        self.push_job(state, job);
        true
    }

    /// Text when a new saved email from this person shows up. The first check only learns what is already saved.
    pub fn add_mail_watch(&self, who: &str) -> Said {
        let name = clip(who, 80);
        if js::len16(&name) < 2 {
            return Said { ok: false, text: "Say the person's name. For example, tell me when Eman emails.".into() };
        }
        let key = name.to_lowercase();
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let found = state
            .jobs
            .iter_mut()
            .find(|j| is_active_watch(j) && s(&j["watch"], "type") == "mail" && s(&j["watch"], "who").to_lowercase() == key);
        if let Some(existing) = found {
            set(existing, json!({ "receipt": "Still watching.", "updated": now }));
            let text = format!("I am already watching for email from {}.", s(&existing["watch"], "who"));
            self.save(&state);
            return Said { ok: true, text };
        }
        let job = json!({
            "kind": "watch",
            "status": "waiting",
            "title": format!("Email from {name}"),
            "detail": format!("I will text you when a new email from {name} is saved on this Mac."),
            "watch": { "type": "mail", "who": name },
            "lastText": "",
            "receipt": "Not checked yet.",
        });
        if !self.add_standing_watch(&mut state, job) {
            return Said { ok: false, text: "You already have 8 watches. Say stop watching, then add a new one.".into() };
        }
        Said { ok: true, text: format!("I will text you when a new email from {name} is saved. The first check only learns what is already there.") }
    }

    /// Text when a meeting starts before this hour, today if it is not over, or tomorrow.
    pub fn add_meeting_watch(&self, before_hour: i64) -> Said {
        if !(1..=23).contains(&before_hour) {
            return Said { ok: false, text: "Say a time like before 9, or before 9 am.".into() };
        }
        let label = clock_phrase(before_hour as u32, 0);
        let title = format!("Meetings before {label}");
        let detail = format!("I will text you if a meeting starts before {label}.");
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        if let Some(existing) = state.jobs.iter_mut().find(|j| is_active_watch(j) && s(&j["watch"], "type") == "meeting") {
            existing["watch"]["beforeHour"] = json!(before_hour);
            set(existing, json!({ "title": title, "detail": detail, "lastText": "", "receipt": "Watching again from now.", "status": "waiting", "updated": now }));
            self.save(&state);
            return Said { ok: true, text: detail };
        }
        let job = json!({
            "kind": "watch",
            "status": "waiting",
            "title": title,
            "detail": detail,
            "watch": { "type": "meeting", "beforeHour": before_hour },
            "lastText": "",
            "receipt": "Not checked yet.",
        });
        if !self.add_standing_watch(&mut state, job) {
            return Said { ok: false, text: "You already have 8 watches. Say stop watching, then add a new one.".into() };
        }
        Said { ok: true, text: format!("{detail} That means later today, if it is not over, or tomorrow.") }
    }

    /// Remember the latest mark for a mail or meeting watch.
    /// Returns the job when the caller should text the user.
    /// A watch stopped while it was being checked stays stopped.
    pub fn set_watch_mark(&self, id: &str, mark: &str, tell: bool, receipt: &str) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let job = state.jobs.iter_mut().find(|j| j["id"] == id && is_active_watch(j))?;
        set(job, json!({ "updated": now, "lastText": mark, "receipt": clip(receipt, 200) }));
        if tell {
            set(job, json!({ "status": "alerted" }));
        }
        let job = tell.then(|| job.clone());
        self.save(&state);
        job
    }

    /// Stop one watch. "meeting" stops the early-meeting watch. Other words match an email name,
    /// either way round, so "Eman" stops a watch on "Eman Sultan".
    pub fn stop_watch(&self, words: &str) -> Said {
        let key = clip(words, 200).to_lowercase();
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let mut titles = Vec::new();
        for job in state.jobs.iter_mut().filter(|j| is_active_watch(j)) {
            let who = s(&job["watch"], "who").to_lowercase();
            let hit = match s(&job["watch"], "type") {
                "meeting" => js_re!(r"\bmeetings?\b", "").test(&key),
                "mail" => !key.is_empty() && !who.is_empty() && (key.contains(&who) || who.contains(&key)),
                _ => false,
            };
            if hit {
                set(job, json!({ "status": "skipped", "receipt": "You asked me to stop watching.", "updated": now }));
                titles.push(s(job, "title").to_string());
            }
        }
        if titles.is_empty() {
            return Said { ok: false, text: "I am not watching that.".into() };
        }
        self.save(&state);
        let name = if titles.len() == 1 { titles.remove(0) } else { format!("{} watches", titles.len()) };
        Said { ok: true, text: format!("Stopped watching {name}.") }
    }

    pub fn add_reminder(&self, title: &str, due_at_ms: i64) -> Value {
        let when = Local.timestamp_millis_opt(due_at_ms).unwrap();
        let mut state = self.state.lock().unwrap();
        self.push_job(
            &mut state,
            json!({
                "kind": "reminder",
                "status": "waiting",
                "title": clip(title, 180),
                "detail": format!("I will text you at {}.", when.format("%A %-I:%M %p")),
                "dueAt": due_at_ms,
                "receipt": "Waiting.",
            }),
        )
    }

    pub fn take_due_reminders(&self, now_ms: i64) -> Vec<Value> {
        let mut state = self.state.lock().unwrap();
        let now = self.now_iso();
        let due: Vec<usize> = (0..state.jobs.len())
            .filter(|&i| {
                let j = &state.jobs[i];
                s(j, "kind") == "reminder" && s(j, "status") == "waiting" && j["dueAt"].as_f64().is_some_and(|d| d <= now_ms as f64)
            })
            .collect();
        let mut taken = Vec::new();
        for &i in due.iter().take(5) {
            set(&mut state.jobs[i], json!({ "status": "done", "receipt": "Reminded you.", "updated": now }));
            taken.push(state.jobs[i].clone());
        }
        if !due.is_empty() {
            self.save(&state);
        }
        taken
    }

    /// One scheduled job's index, or the reply when there is none or more than one.
    /// target is the words the user said, or `{ "id": ... }` from a button on the card.
    fn one_schedule(state: &State, target: &Value) -> Result<usize, Value> {
        let live = live_schedules(state);
        if let Some(id) = target["id"].as_str().filter(|id| !id.is_empty()) {
            return live.into_iter().find(|&i| state.jobs[i]["id"] == id).ok_or_else(|| reply(false, "That scheduled job is not here."));
        }
        let terms = schedule_terms(&js::to_str(target));
        let hits: Vec<usize> = if terms.is_empty() {
            vec![]
        } else {
            live.into_iter()
                .filter(|&i| {
                    let job = &state.jobs[i];
                    let hay = format!("{} {}", s(job, "title"), s(&job["schedule"], "ask")).to_lowercase();
                    terms.iter().all(|term| hay.contains(term.as_str()))
                })
                .collect()
        };
        match hits.as_slice() {
            [] => Err(reply(false, "I don't have a scheduled job with those words. Say what jobs to hear them.")),
            [i] => Ok(*i),
            _ => {
                let names = hits.iter().map(|&i| s(&state.jobs[i], "title")).collect::<Vec<_>>().join("; ");
                Err(reply(false, format!("More than one job matches. {names}.")))
            }
        }
    }

    /// Save a repeating job. plan has days, hour, minute, mode, and ask.
    pub fn add_schedule(&self, plan: &Value, now_ms: i64) -> Value {
        let mut days: Vec<i64> = plan["days"].as_array().map(|list| list.iter().filter_map(Value::as_i64).filter(|n| (0..=6).contains(n)).collect()).unwrap_or_default();
        days.sort();
        days.dedup();
        let hour = plan["hour"].as_i64().unwrap_or(-1);
        let minute = plan["minute"].as_i64().unwrap_or(-1);
        let mode = if plan["mode"] == "remind" { "remind" } else { "ask" };
        let ask = clip(plan["ask"].as_str().unwrap_or(""), 300);
        if ask.is_empty() || days.is_empty() || !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
            return reply(false, "Say every weekday at 8 am, text me, and then the question.");
        }
        let mut state = self.state.lock().unwrap();
        let active = live_schedules(&state);
        let same = active.iter().find(|&&i| {
            let saved = &state.jobs[i]["schedule"];
            saved["mode"] == mode
                && saved["hour"].as_i64() == Some(hour)
                && saved["minute"].as_i64() == Some(minute)
                && s(saved, "ask").to_lowercase() == ask.to_lowercase()
                && clock_of(saved).0 == days
        });
        if let Some(&i) = same {
            return reply(true, format!("You already have that job: {}.", s(&state.jobs[i], "title")));
        }
        if active.len() >= MAX_SCHEDULES {
            return reply(false, "You already have 8 scheduled jobs. Say drop, then a few words from one of them.");
        }
        let mut fields = json!({
            "kind": "schedule",
            "status": "waiting",
            "title": clip(&ask, 180),
            "detail": "",
            "dueAt": 0,
            "receipt": "Waiting.",
            "schedule": { "days": days, "hour": hour, "minute": minute, "mode": mode, "ask": ask },
        });
        if !retime(&mut fields, now_ms, None) {
            return reply(false, "I could not find a next time for that.");
        }
        let job = self.push_job(&mut state, fields);
        let how = if mode == "ask" { "I will ask that and text you the answer." } else { "I will text you that reminder." };
        json!({ "ok": true, "text": format!("{} {how}", s(&job, "detail")), "job": job })
    }

    /// Stop a repeating job until the user says resume.
    pub fn pause_schedule(&self, target: &Value) -> Value {
        let mut state = self.state.lock().unwrap();
        let i = match Self::one_schedule(&state, target) {
            Ok(i) => i,
            Err(err) => return err,
        };
        let title = s(&state.jobs[i], "title").to_string();
        if s(&state.jobs[i], "status") == "paused" {
            return reply(true, format!("Already paused: {title}."));
        }
        let now = self.now_iso();
        set(&mut state.jobs[i], json!({ "status": "paused", "receipt": "Paused.", "updated": now }));
        self.save(&state);
        reply(true, format!("Paused: {title}. It will not run until you say resume."))
    }

    /// Turn a paused job back on. The next run is the next future clock time, not a missed one.
    pub fn resume_schedule(&self, target: &Value, now_ms: i64) -> Value {
        let mut state = self.state.lock().unwrap();
        let i = match Self::one_schedule(&state, target) {
            Ok(i) => i,
            Err(err) => return err,
        };
        let now = self.now_iso();
        let job = &mut state.jobs[i];
        if !retime(job, now_ms, None) {
            return reply(false, "I could not find a next time for that.");
        }
        set(job, json!({ "status": "waiting", "receipt": "Waiting.", "updated": now }));
        let text = format!("On again: {}. {}", s(job, "title"), s(job, "detail"));
        self.save(&state);
        reply(true, text)
    }

    /// Remove a repeating job. It does not come back.
    pub fn drop_schedule(&self, target: &Value) -> Value {
        let mut state = self.state.lock().unwrap();
        let i = match Self::one_schedule(&state, target) {
            Ok(i) => i,
            Err(err) => return err,
        };
        let now = self.now_iso();
        set(&mut state.jobs[i], json!({ "status": "skipped", "receipt": "You dropped this job.", "updated": now }));
        let text = format!("Dropped: {}.", s(&state.jobs[i], "title"));
        self.save(&state);
        reply(true, text)
    }

    /// Keep the same question, change the clock time. A paused job stays paused.
    pub fn move_schedule(&self, target: &Value, hour: u32, minute: u32, now_ms: i64) -> Value {
        let mut state = self.state.lock().unwrap();
        let i = match Self::one_schedule(&state, target) {
            Ok(i) => i,
            Err(err) => return err,
        };
        let now = self.now_iso();
        let job = &mut state.jobs[i];
        if !retime(job, now_ms, Some((hour, minute))) {
            return reply(false, "I could not find a next time for that.");
        }
        job["schedule"]["hour"] = json!(hour);
        job["schedule"]["minute"] = json!(minute);
        let receipt = if s(job, "status") == "paused" { "Paused." } else { "Waiting." };
        set(job, json!({ "receipt": receipt, "updated": now }));
        let text = format!("Moved: {}. {}", s(job, "title"), s(job, "detail"));
        self.save(&state);
        reply(true, text)
    }

    /// Repeating jobs whose time has arrived. Each moves to its next future time first,
    /// so a slow answer cannot send one twice, and a Mac that slept sends one, not a burst.
    pub fn take_due_schedules(&self, now_ms: i64) -> Vec<Value> {
        let mut state = self.state.lock().unwrap();
        let due: Vec<usize> = (0..state.jobs.len())
            .filter(|&i| {
                let job = &state.jobs[i];
                s(job, "kind") == "schedule" && s(job, "status") == "waiting" && job["dueAt"].as_f64().is_some_and(|d| d <= now_ms as f64)
            })
            .take(3)
            .collect();
        let now = self.now_iso();
        let mut taken = Vec::new();
        for i in due {
            let job = &mut state.jobs[i];
            if !retime(job, now_ms, None) {
                continue;
            }
            set(job, json!({ "receipt": "Ran.", "updated": now }));
            taken.push(job.clone());
        }
        if !taken.is_empty() {
            self.save(&state);
        }
        taken
    }

    pub fn jobs_sentence(&self) -> String {
        let state = self.state.lock().unwrap();
        let open: Vec<&Value> = state.jobs.iter().filter(|j| is_open(j)).collect();
        if open.is_empty() {
            return "Nothing is waiting. You can say watch and a web address, remind me in 20 minutes to, and then the task, every weekday at 8 am text me, and then a question, or ask me to draft an email.".into();
        }
        let lines: Vec<String> = open
            .iter()
            .map(|job| {
                let title = s(job, "title");
                let alerted = s(job, "status") == "alerted";
                let watch = &job["watch"];
                match s(job, "kind") {
                    "draft" => format!("A draft is waiting: {title}. Say send it, or don't."),
                    "watch" if s(watch, "type") == "mail" && alerted => format!("New email from {}. Say got it when you have seen it.", s(watch, "who")),
                    "watch" if s(watch, "type") == "mail" => format!("Watching for email from {}.", s(watch, "who")),
                    "watch" if s(watch, "type") == "meeting" && alerted => "An early meeting showed up. Say got it when you have seen it.".into(),
                    "watch" if s(watch, "type") == "meeting" => {
                        format!("Watching for a meeting before {}.", clock_phrase(watch["beforeHour"].as_u64().unwrap_or(0) as u32, 0))
                    }
                    "watch" if alerted => format!("{title} changed. Say got it when you have seen it."),
                    "watch" => format!("Watching {title}."),
                    "schedule" if s(job, "status") == "paused" => format!("Paused: {title}."),
                    "schedule" => format!("Scheduled: {title}."),
                    _ => format!("Reminder: {title}."),
                }
            })
            .collect();
        let count = if open.len() == 1 { "One job".to_string() } else { format!("{} jobs", open.len()) };
        format!("{count}. {}", lines.join(" "))
    }

    pub fn suggestions_sentence(&self) -> String {
        let state = self.state.lock().unwrap();
        if state.suggestions.is_empty() {
            return "I have no ideas waiting. Recent emails show up here when there is one from the last two days.".into();
        }
        let lines: Vec<String> = state
            .suggestions
            .iter()
            .enumerate()
            .map(|(i, item)| format!("{}, {}, {}", i + 1, s(item, "title"), s(item, "source")))
            .collect();
        format!("Ideas you can skip. {}. Say do number one, or skip number one.", lines.join(". "))
    }

    /// Replace the idea list with the latest emails.
    /// Anything you already skipped stays skipped.
    pub fn merge_suggestions(&self, items: &[Suggestion]) -> Vec<Value> {
        let mut state = self.state.lock().unwrap();
        let mut next: Vec<Value> = Vec::new();
        for item in items {
            if item.key.is_empty() || state.dismissed.iter().any(|d| *d == item.key.as_str()) {
                continue;
            }
            if next.len() >= MAX_SUGGESTIONS {
                break;
            }
            let previous = state.suggestions.iter().find(|e| e["key"] == item.key.as_str());
            let mut entry = json!({
                "id": &hex::encode(Sha256::digest(item.key.as_bytes()))[..12],
                "key": item.key,
                "title": clip(&item.title, 180),
                "source": clip(&item.source, 80),
                "detail": clip(&item.detail, 180),
            });
            // Left out when unknown, as JSON.stringify drops undefined.
            if let Some(at) = item.at.filter(|a| *a != 0.0 && !a.is_nan()) {
                entry["at"] = number(at);
            }
            // Keep a summary we already paid Haiku to write for this same email.
            entry["summary"] = previous.map_or(json!(""), |p| or_empty(&p["summary"]));
            next.push(entry);
        }
        state.suggestions = next.clone();
        self.save(&state);
        next
    }

    pub fn suggestion_by_id(&self, id: &str) -> Option<Value> {
        self.state.lock().unwrap().suggestions.iter().find(|i| i["id"] == id).cloned()
    }

    pub fn suggestion_at(&self, index: usize) -> Option<Value> {
        self.state.lock().unwrap().suggestions.get(index).cloned()
    }

    pub fn dismiss_suggestion(&self, id: &str) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let item = state.suggestions.iter().find(|i| i["id"] == id)?.clone();
        if !state.dismissed.contains(&item["key"]) {
            state.dismissed.push(item["key"].clone());
        }
        let skip = state.dismissed.len().saturating_sub(200);
        state.dismissed.drain(..skip);
        state.suggestions.retain(|e| e["id"] != id);
        self.save(&state);
        Some(item)
    }
}

/// `{ ok, text }`, the reply a desk call gives.
fn reply(ok: bool, text: impl Into<String>) -> Value {
    json!({ "ok": ok, "text": text.into() })
}

/// 8 pm is 20. 12 am is midnight. The hour must already be 1–12.
fn clock_hour(hour: u32, mark: &str) -> u32 {
    match (mark, hour) {
        ("pm", h) if h < 12 => h + 12,
        ("am", 12) => 0,
        (_, h) => h,
    }
}

/// "8:00 AM", with the minutes always two digits.
fn clock_phrase(hour: u32, minute: u32) -> String {
    let mark = if hour >= 12 { "PM" } else { "AM" };
    let shown = if hour.is_multiple_of(12) { 12 } else { hour % 12 };
    format!("{shown}:{minute:02} {mark}")
}

/// "Every weekday" or "Every Monday". days is sorted, Sunday = 0.
fn day_phrase(days: &[i64]) -> String {
    match days {
        [0, 1, 2, 3, 4, 5, 6] => "Every day".into(),
        [1, 2, 3, 4, 5] => "Every weekday".into(),
        [0, 6] => "Every weekend".into(),
        _ => format!("Every {}", days.iter().map(|&d| DAY_WORDS[d as usize]).collect::<Vec<_>>().join(", ")),
    }
}

/// A wall-clock time read the way JS `setHours` reads it. In the hour that repeats when
/// clocks go back, the first one. In the hour skipped when they go forward, the same
/// wall time on the offset from before the jump, so 2:30 becomes 3:30.
fn local_at(naive: NaiveDateTime) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(when) => Some(when),
        LocalResult::Ambiguous(a, b) => Some(a.min(b)),
        LocalResult::None => {
            let before = Local.from_local_datetime(&(naive - Days::hours(3))).earliest()?.offset().fix();
            Some(before.from_local_datetime(&naive).single()?.with_timezone(&Local))
        }
    }
}

/// The next time this clock time falls on one of these days, strictly after after_ms.
/// Uses this Mac's clock. 0 when no day in the next week matches.
fn next_fire(days: &[i64], hour: u32, minute: u32, after_ms: i64) -> i64 {
    let (Some(start), Some(time)) = (Local.timestamp_millis_opt(after_ms).single(), NaiveTime::from_hms_opt(hour, minute, 0)) else {
        return 0;
    };
    (0..8)
        .filter_map(|add| local_at(start.date_naive().checked_add_signed(Days::days(add))?.and_time(time)))
        .find(|when| days.contains(&i64::from(when.weekday().num_days_from_sunday())) && when.timestamp_millis() > after_ms)
        .map_or(0, |when| when.timestamp_millis())
}

/// The days, hour, and minute of a saved repeating job.
fn clock_of(saved: &Value) -> (Vec<i64>, u32, u32) {
    let days = saved["days"].as_array().map(|list| list.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    (days, saved["hour"].as_u64().unwrap_or(0) as u32, saved["minute"].as_u64().unwrap_or(0) as u32)
}

/// Point a repeating job at its next clock time after now, and say it on the card.
/// clock replaces the saved hour and minute. False, and nothing changed, when there is no next time.
fn retime(job: &mut Value, now_ms: i64, clock: Option<(u32, u32)>) -> bool {
    let (days, hour, minute) = clock_of(&job["schedule"]);
    let (hour, minute) = clock.unwrap_or((hour, minute));
    let due_at = next_fire(&days, hour, minute, now_ms);
    if due_at == 0 {
        return false;
    }
    let when = Local.timestamp_millis_opt(due_at).single().map(|w| w.format("%A %-I:%M %p").to_string()).unwrap_or_default();
    set(job, json!({ "dueAt": due_at, "detail": format!("{} at {}. Next: {when}.", day_phrase(&days), clock_phrase(hour, minute)) }));
    true
}

/// Scheduled jobs that are still on or paused.
fn live_schedules(state: &State) -> Vec<usize> {
    (0..state.jobs.len())
        .filter(|&i| s(&state.jobs[i], "kind") == "schedule" && matches!(s(&state.jobs[i], "status"), "waiting" | "paused"))
        .collect()
}

/// The words that help pick one scheduled job out of the list.
fn schedule_terms(words: &str) -> Vec<String> {
    js_re!(r"[^a-z0-9\s]", "g")
        .replace(&words.to_lowercase(), " ")
        .split_whitespace()
        .filter(|word| word.len() > 2 && !matches!(*word, "the" | "my" | "job" | "jobs" | "scheduled" | "schedule" | "reminder" | "one"))
        .map(str::to_string)
        .collect()
}

fn load(file: &PathBuf) -> State {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Failed while reading desk.json: {err}");
            }
            return State::empty();
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v @ Value::Object(_)) => v,
        Ok(_) => {
            eprintln!("Failed while reading desk.json: not an object");
            return State::empty();
        }
        Err(err) => {
            eprintln!("Failed while reading desk.json: {err}");
            return State::empty();
        }
    };
    let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    State {
        jobs: list(&parsed["jobs"]),
        suggestions: list(&parsed["suggestions"]),
        dismissed: list(&parsed["dismissed"]),
        summary: text(&parsed["memory"]["summary"]),
        turns: list(&parsed["memory"]["turns"]),
        saved_at: text(&parsed["memory"]["savedAt"]),
    }
}

/// A spoken request understood as a desk action.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum DeskAction {
    CancelWatches,
    ClearAlerts,
    Jobs,
    Suggestions,
    Confirm,
    Skip,
    Do { index: usize },
    SkipSuggestion { index: usize },
    Say { text: String },
    Watch { url: String },
    WatchMail { who: String },
    WatchMeeting { #[serde(rename = "beforeHour")] before_hour: u32 },
    StopWatch { words: String },
    Remind { title: String, #[serde(rename = "dueAt")] due_at: i64 },
    Schedule { days: Vec<i64>, hour: u32, minute: u32, mode: String, ask: String },
    PauseSchedule { words: String },
    ResumeSchedule { words: String },
    DropSchedule { words: String },
    MoveSchedule { words: String, hour: u32, minute: u32 },
}

fn pull_url(text: &str) -> String {
    let found = js_re!(r"https?:\/\/[^\s]+", "i")
        .exec(text)
        .or_else(|| js_re!(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?", "i").exec(text));
    let Some(found) = found else { return String::new() };
    let mut url = js_re!(r"[.,!?;)]+$", "g").replace(found[0].as_deref().unwrap_or(""), "");
    if !js_re!(r"^https?:\/\/", "i").test(&url) {
        url = format!("https://{url}");
    }
    match url::Url::parse(&url) {
        Ok(p) if p.scheme() == "http" || p.scheme() == "https" => p.as_str().to_string(),
        Ok(_) => String::new(),
        Err(err) => {
            eprintln!("Failed while reading a web address from speech: {err}");
            String::new()
        }
    }
}

fn number_index(word: &str) -> usize {
    match word.to_lowercase().as_str() {
        "one" | "first" | "1" => 0,
        "two" | "second" | "2" => 1,
        "three" | "third" | "3" => 2,
        _ => 3,
    }
}

/// Turn a spoken request into a desk action.
/// Returns None when the sentence is about something else.
pub fn parse_desk(question: &str, now_ms: i64) -> Option<DeskAction> {
    let q = js_re!(r#"^["“'\s.,]+|["”'\s.?!]+$"#, "g").replace(js::trim(question), "");
    if q.is_empty() {
        return None;
    }
    let say = |text: &str| Some(DeskAction::Say { text: text.into() });

    if let Some(stop_mail) = js_re!(r"^(?:please\s+)?stop watching (?:for )?(?:new )?(?:e-?mails?|mail) from (.+)$", "i").exec(&q) {
        return Some(DeskAction::StopWatch { words: js::trim(stop_mail[1].as_deref().unwrap_or("")).to_string() });
    }
    if js_re!(r"^(?:please\s+)?stop watching (?:the )?(?:early )?meetings?(?: before \d{1,2}(?::\d{2})?\s*(?:am|pm)?)?$", "i").test(&q) {
        return Some(DeskAction::StopWatch { words: "meeting".into() });
    }
    if js_re!(r"^(?:please\s+)?(?:stop watching|cancel (?:the )?watches|cancel (?:the )?watch|stop the watch)\b", "i").test(&q) {
        return Some(DeskAction::CancelWatches);
    }
    if js_re!(r"^(?:please\s+)?(?:got it|dismiss that|clear the alert)\b", "i").test(&q) {
        return Some(DeskAction::ClearAlerts);
    }
    if js_re!(r"^(?:please\s+)?(?:what(?:'s| is) (?:waiting|on your list)|what jobs|my jobs|what are you watching|list (?:the )?jobs)\b", "i").test(&q) {
        return Some(DeskAction::Jobs);
    }
    if js_re!(r"^(?:please\s+)?(?:what should i do|any suggestions|what are the ideas|list (?:the )?ideas)\b", "i").test(&q) {
        return Some(DeskAction::Suggestions);
    }
    if js_re!(r"^(?:please\s+)?(?:yes[, ]+)?(?:send it|open it|go ahead|open that|yes send it)[.!]*$", "i").test(&q) {
        return Some(DeskAction::Confirm);
    }
    if js_re!(r"^(?:please\s+)?(?:don'?t|do not send it|drop it|cancel that|never mind|nevermind)[.!]*$", "i").test(&q) {
        return Some(DeskAction::Skip);
    }

    let picked = js_re!(
        r"^(?:please\s+)?(do|skip) (?:the )?(?:number )?(one|two|three|four|first|second|third|fourth|1|2|3|4)(?: suggestion| idea)?$",
        "i"
    )
    .exec(&q);
    if let Some(p) = picked {
        let index = number_index(p[2].as_deref().unwrap_or(""));
        return Some(if p[1].as_deref().unwrap_or("").eq_ignore_ascii_case("do") {
            DeskAction::Do { index }
        } else {
            DeskAction::SkipSuggestion { index }
        });
    }

    let mail_watch = js_re!(r"^(?:please\s+)?(?:tell me|let me know|text me) when (?:i get |there is |there's )?(?:an? |the )?(?:new )?e-?mails? from (.+)$", "i").exec(&q)
        .or_else(|| js_re!(r"^(?:please\s+)?(?:watch|keep an eye on) (?:for )?(?:e-?mails?|mail) from (.+)$", "i").exec(&q))
        .or_else(|| js_re!(r"^(?:please\s+)?(?:tell me|let me know|text me) when (.+?) e-?mails?(?: me)?$", "i").exec(&q));
    // "Tell me when I get emails" names nobody, so it is not a watch.
    if let Some(found) = mail_watch.filter(|m| !js_re!(r"^(?:i|we|you|it|they|there|someone|anyone)\b", "i").test(m[1].as_deref().unwrap_or(""))) {
        let who = js_re!(r"^(?:an?|the)\s+", "i").replace(found[1].as_deref().unwrap_or(""), "");
        return Some(DeskAction::WatchMail { who: js::trim(&who).to_string() });
    }
    if let Some(meeting) = js_re!(r"^(?:please\s+)?(?:tell me|text me|let me know) if (?:i have |there is |there's |tomorrow has )?(?:a |an )?meetings?(?: that starts?)? before (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", "i").exec(&q) {
        if meeting[2].is_some() {
            return say("Say before 9, or before 9 am. I watch the hour, not the minutes.");
        }
        let hour12: u32 = meeting[1].as_deref().unwrap_or("0").parse().unwrap_or(0);
        let hour = clock_hour(hour12, &meeting[3].as_deref().unwrap_or("").to_lowercase());
        // 12 am is midnight: nothing starts before it.
        if !(1..=12).contains(&hour12) || hour < 1 {
            return say("Say a time like before 9, or before 9 am.");
        }
        return Some(DeskAction::WatchMeeting { before_hour: hour });
    }

    if js_re!(r"^(?:please\s+)?(?:can you\s+|could you\s+)?(?:watch|keep an eye on|track)\b", "i").test(&q) {
        let url = pull_url(&q);
        if url.is_empty() {
            return say("Say watch, then the web address. For example, watch https://example.com.");
        }
        return Some(DeskAction::Watch { url });
    }

    // "Change the email job to 9:30 am" keeps the question and moves the clock.
    // These all need the word job, so "move the meeting to 3 pm" or "pause the music"
    // is left for the rest of the app.
    if let Some(mv) = js_re!(r"^(?:please\s+)?(?:change|move) (?:the |my )?(.+?) job to (\d{1,2})(?::(\d{2}))?\s*(am|pm)$", "i").exec(&q) {
        let hour12: u32 = mv[2].as_deref().unwrap_or("0").parse().unwrap_or(0);
        let minute: u32 = mv[3].as_deref().map_or(0, |m| m.parse().unwrap_or(0));
        if !(1..=12).contains(&hour12) || minute > 59 {
            return say("Say the hour like 9 am, or 9:30 pm.");
        }
        let hour = clock_hour(hour12, &mv[4].as_deref().unwrap_or("").to_lowercase());
        return Some(DeskAction::MoveSchedule { words: js::trim(mv[1].as_deref().unwrap_or("")).to_string(), hour, minute });
    }
    if let Some(tune) = js_re!(r"^(?:please\s+)?(pause|resume) (?:the |my )?(.+?) job$", "i").exec(&q) {
        let words = js::trim(tune[2].as_deref().unwrap_or("")).to_string();
        return Some(if tune[1].as_deref().unwrap_or("").eq_ignore_ascii_case("resume") {
            DeskAction::ResumeSchedule { words }
        } else {
            DeskAction::PauseSchedule { words }
        });
    }
    if let Some(drop) = js_re!(r"^(?:please\s+)?(?:drop|cancel) (?:the |my )?(.+?) job$", "i").exec(&q) {
        return Some(DeskAction::DropSchedule { words: js::trim(drop[1].as_deref().unwrap_or("")).to_string() });
    }

    // "Every weekday at 8 am, text me which emails need a reply."
    // Only "every ... at 8" gets help, so "every cell has DNA" still reaches the brain.
    if js_re!(r"^(?:please\s+)?every (?:\S+ ){1,2}at \d", "i").test(&q) {
        let Some(parsed) = js_re!(
            r"^(?:please\s+)?every (day|weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)[,:]?\s+(.+)$",
            "i"
        )
        .exec(&q) else {
            return say("Say every weekday at 8 am, text me, and then the question. Or say every day at 9 pm, remind me to, and the task.");
        };
        let hour12: u32 = parsed[2].as_deref().unwrap_or("0").parse().unwrap_or(0);
        let minute: u32 = parsed[3].as_deref().map_or(0, |m| m.parse().unwrap_or(0));
        if !(1..=12).contains(&hour12) || minute > 59 {
            return say("Say the hour like 8 am, or 9:30 pm.");
        }
        let hour = clock_hour(hour12, &parsed[4].as_deref().unwrap_or("").to_lowercase());
        let rest = parsed[5].as_deref().unwrap_or("");
        let remind = js_re!(r"^(?:remind me(?: to)?|remember to)\s+(.+)$", "i").exec(js::trim(rest));
        let ask = match &remind {
            Some(hit) => js::trim(hit[1].as_deref().unwrap_or("")).to_string(),
            None => js::trim(&js_re!(r"^(?:text me|tell me|ask me|ask)\s+", "i").replace(rest, "")).to_string(),
        };
        if ask.is_empty() {
            return say("Say what I should do at that time.");
        }
        let days = match parsed[1].as_deref().unwrap_or("").to_lowercase().as_str() {
            "day" => vec![0, 1, 2, 3, 4, 5, 6],
            "weekday" | "weekdays" => vec![1, 2, 3, 4, 5],
            "weekend" | "weekends" => vec![0, 6],
            name => DAY_WORDS.iter().position(|day| day.eq_ignore_ascii_case(name)).map(|i| i as i64).into_iter().collect(),
        };
        return Some(DeskAction::Schedule { days, hour, minute, mode: if remind.is_some() { "remind" } else { "ask" }.into(), ask });
    }

    if js_re!(r"^remind me\b", "i").test(&q) {
        if let Some(soon) = js_re!(r"^remind me in (\d{1,4}) (minute|minutes|hour|hours)(?: to)? (.+)$", "i").exec(&q) {
            let count: i64 = soon[1].as_deref().unwrap_or("0").parse().unwrap_or(0);
            let ms = if js_re!(r"hour", "i").test(soon[2].as_deref().unwrap_or("")) { count * 3_600_000 } else { count * 60_000 };
            if count < 1 || ms > 14 * 86_400_000 {
                return say("Say a time from one minute up to two weeks.");
            }
            return Some(DeskAction::Remind { title: js::trim(soon[3].as_deref().unwrap_or("")).into(), due_at: now_ms + ms });
        }
        if let Some(at) = js_re!(r"^remind me (tomorrow )?at (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: to)? (.+)$", "i").exec(&q) {
            let tomorrow = at[1].is_some();
            let hour: u32 = at[2].as_deref().unwrap_or("0").parse().unwrap_or(0);
            let minute: u32 = at[3].as_deref().map_or(0, |m| m.parse().unwrap_or(0));
            if hour > 12 || minute > 59 {
                return say("Say the hour like 3 pm, or 9:30 am.");
            }
            let h = clock_hour(hour, &at[4].as_deref().unwrap_or("").to_lowercase());
            let mut day = Local.timestamp_millis_opt(now_ms).unwrap().date_naive();
            if tomorrow {
                day += Days::days(1);
            }
            let at_clock = |d: chrono::NaiveDate| {
                let local = d.and_time(NaiveTime::from_hms_opt(h, minute, 0).unwrap());
                local_at(local).map_or(0, |when| when.timestamp_millis())
            };
            let mut when = at_clock(day);
            if !tomorrow && when <= now_ms {
                when = at_clock(day + Days::days(1));
            }
            return Some(DeskAction::Remind { title: js::trim(at[5].as_deref().unwrap_or("")).into(), due_at: when });
        }
        return say("Say remind me in 20 minutes to, and then what I should remind you about. Or say remind me tomorrow at 9 am to, and the task.");
    }

    None
}
