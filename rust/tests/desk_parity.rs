//! Golden test: Rust desk must match `second-brain/desk.js`, down to the bytes
//! of desk.json after every call. Fixture comes from
//! `node rust/tests/fixtures/gen_desk.mjs` (fixed clock, counting ids, Asia/Amman).

use nemo_realtime_voice::desk::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/desk.json")).unwrap()
}

fn amman() {
    // Both tests set the same value, so running them in parallel is safe.
    std::env::set_var("TZ", "Asia/Amman");
}

#[test]
fn every_call_and_the_file_match_node() {
    amman();
    let f = fixture();
    let dir = std::env::temp_dir().join(format!("desk-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("desk.json");
    std::fs::write(&file, serde_json::to_string_pretty(&f["seed"]).unwrap()).unwrap();

    let now = Arc::new(AtomicI64::new(0));
    let ids = Arc::new(AtomicU32::new(0));
    let (n, i) = (now.clone(), ids.clone());
    let desk = Desk::open_with(
        file.clone(),
        Box::new(move || n.load(Ordering::SeqCst)),
        Box::new(move || format!("{:08x}", i.fetch_add(1, Ordering::SeqCst) + 1)),
    );

    for step in f["steps"].as_array().unwrap() {
        now.store(step["now"].as_i64().unwrap(), Ordering::SeqCst);
        let a = &step["args"];
        let st = |k: usize| a[k].as_str().unwrap_or("");
        let out: Value = match step["fn"].as_str().unwrap() {
            "publicDesk" => desk.public_desk(),
            "pendingSummaries" => json!(desk.pending_summaries()),
            "jobsSentence" => json!(desk.jobs_sentence()),
            "suggestionsSentence" => json!(desk.suggestions_sentence()),
            "rememberSummary" => json!(desk.remember_summary(st(0), st(1), st(2))),
            "saveEmailDraft" => {
                let d = &a[0];
                let g = |k: &str| d[k].as_str().unwrap_or("");
                json!(desk.save_email_draft(&EmailDraft {
                    to: g("to"),
                    name: g("name"),
                    subject: g("subject"),
                    body: g("body"),
                    original: g("original"),
                }))
            }
            "saveMeetingDraft" => {
                let p = &a[0];
                let g = |k: &str| p[k].as_str().unwrap_or("").to_string();
                let date = g("date");
                let date = if date == "2026-10-16T06:00:00.000Z" {
                    MeetingDate::At(chrono::DateTime::parse_from_rfc3339(&date).unwrap().timestamp_millis())
                } else {
                    MeetingDate::Text(date)
                };
                let plan = MeetingPlan {
                    subject: g("subject"),
                    body: g("body"),
                    location: g("location"),
                    who: g("who"),
                    duration: p["duration"].as_f64().unwrap(),
                    date,
                    assumed_day: p["assumedDay"] == true,
                    assumed_time: p["assumedTime"] == true,
                };
                desk.save_meeting_draft(&plan, st(1))
            }
            "latestDraft" => json!(desk.latest_draft()),
            "finishLatestEmail" => json!(desk.finish_latest_email(st(0))),
            "finishJob" => json!(desk.finish_job(st(0), st(1), st(2))),
            "addWatch" => json!(desk.add_watch(st(0), st(1))),
            "recordWatch" => json!(desk.record_watch(st(0), st(1), st(2))),
            "watchesToCheck" => json!(desk.watches_to_check()),
            "clearAlerts" => json!(desk.clear_alerts()),
            "cancelWatches" => json!(desk.cancel_watches()),
            "addReminder" => desk.add_reminder(st(0), a[1].as_i64().unwrap()),
            "takeDueReminders" => json!(desk.take_due_reminders(a[0].as_i64().unwrap())),
            "mergeSuggestions" => {
                let items: Vec<Suggestion> = a[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| Suggestion {
                        key: x["key"].as_str().unwrap().into(),
                        title: x["title"].as_str().unwrap().into(),
                        source: x["source"].as_str().unwrap().into(),
                        detail: x["detail"].as_str().unwrap().into(),
                    })
                    .collect();
                json!(desk.merge_suggestions(&items))
            }
            "suggestionAt" => json!(desk.suggestion_at(a[0].as_u64().unwrap() as usize)),
            "dismissSuggestion" => json!(desk.dismiss_suggestion(st(0))),
            "rememberChat" => {
                desk.remember_chat(&a[0], &a[1]);
                Value::Null
            }
            "savedChat" => desk.saved_chat(),
            "forgetChat" => {
                desk.forget_chat();
                Value::Null
            }
            other => panic!("unknown step {other}"),
        };
        // Compare as text: key order and number formatting must match too.
        assert_eq!(out.to_string(), step["out"].to_string(), "result of {} {}", step["fn"], a);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, step["file"].as_str().unwrap(), "desk.json after {} {}", step["fn"], a);
    }
}

#[test]
fn spoken_requests_match_node() {
    amman();
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    for p in f["parses"].as_array().unwrap() {
        let q = p["q"].as_str().unwrap();
        assert_eq!(json!(parse_desk(q, now)), p["out"], "question {q:?}");
    }
}

/// Manual check on a real desk.json (never printed): DESK_FILE=... DESK_OUT=... cargo test -- --ignored real_file
/// Runs forgetChat at a fixed time on a copy; compare DESK_OUT with Node's output using cmp.
#[test]
#[ignore]
fn real_file() {
    amman();
    let (src, out) = (std::env::var("DESK_FILE").unwrap(), std::env::var("DESK_OUT").unwrap());
    std::fs::copy(&src, &out).unwrap();
    let desk = Desk::open_with(out.into(), Box::new(|| 1_792_060_200_000), Box::new(|| "00000001".into()));
    desk.forget_chat();
}
