//! Golden test: Rust email search must match `second-brain/emailsearch.js`.
//! Fixture comes from `node rust/tests/fixtures/gen_emailsearch.mjs`.

use nemo_realtime_voice::emailsearch::*;
use nemo_realtime_voice::openfile::{Config, Files, Help, NoteFile, OpenJob};
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/emailsearch.json")).unwrap()
}

struct Setup {
    mails: Vec<RawMail>,
    osascript: String,
    calls: String,
}

/// The same saved emails and fake osascript as the Node generator.
fn setup(f: &Value, name: &str) -> Setup {
    let dir = std::env::temp_dir().join(format!("mail-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("raw")).unwrap();
    let calls = dir.join("calls.log").to_string_lossy().into_owned();
    let osascript = dir.join("osascript");
    fs::write(
        &osascript,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$3\" >> \"{calls}\"\ncase \"$3\" in\n  *blocked*) echo \"execution error: System Events got an error: osascript is not allowed assistive access. (-1719)\" >&2; exit 1 ;;\n  *broken*) echo \"execution error: Microsoft Outlook got an error.\" >&2; echo \"second line\" >&2; exit 1 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&osascript, fs::Permissions::from_mode(0o755)).unwrap();
    let mails = f["mails"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let rel = m["rel"].as_str().unwrap();
            let full = dir.join(rel);
            let name = rel.strip_prefix("raw/").unwrap();
            fs::write(&full, f["texts"][name].as_str().unwrap()).unwrap();
            RawMail {
                rel: rel.into(),
                title: m["title"].as_str().unwrap().into(),
                full: full.to_string_lossy().into_owned(),
                mtime: m["mtime"].as_f64().unwrap(),
                size: m["size"].as_u64().unwrap(),
                lower_name: m["lowerName"].as_str().unwrap().into(),
                words: m["words"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().into()).collect(),
            }
        })
        .collect();
    Setup { mails, osascript: osascript.to_string_lossy().into_owned(), calls }
}

fn files() -> std::sync::Arc<Files> {
    Files::new(Config { home: "/nonexistent".into(), mdfind: "/usr/bin/false".into(), ..Config::default() })
}

#[test]
fn spoken_requests_match_node() {
    for p in fixture()["parses"].as_array().unwrap() {
        let got = email_search_job(p["q"].as_str().unwrap()).map(|j| json!({ "query": j.query, "open": j.open }));
        assert_eq!(json!(got), p["out"], "question {}", p["q"]);
    }
}

#[test]
fn search_matches_node() {
    let f = fixture();
    let s = setup(&f, "search");
    for c in f["searches"].as_array().unwrap() {
        let got: Vec<&str> = search_emails(c["q"].as_str().unwrap(), &s.mails).iter().map(|m| m.rel.as_str()).collect();
        assert_eq!(json!(got), c["out"], "query {}", c["q"]);
    }
}

#[tokio::test]
async fn answers_and_outlook_calls_match_node() {
    std::env::set_var("TZ", "Asia/Amman");
    let f = fixture();
    let s = setup(&f, "runs");
    let now = f["now"].as_i64().unwrap();
    for r in f["runs"].as_array().unwrap() {
        fs::write(&s.calls, "").unwrap();
        let job = MailJob { query: r["job"]["query"].as_str().unwrap().into(), open: r["job"]["open"] == true };
        let out = run_email_search(&job, &s.mails, &files(), &s.osascript, now).await;
        assert_eq!(json!(out), r["out"], "job {}", r["job"]);
        let queries: Vec<String> = fs::read_to_string(&s.calls).unwrap().lines().map(String::from).collect();
        assert_eq!(json!(queries), r["queries"], "osascript calls for {}", r["job"]);
    }
}

#[test]
fn outlook_script_matches_node() {
    // The AppleScript is private; check it through a fake osascript that saves argument 2.
    let f = fixture();
    let s = setup(&f, "script");
    let saved = format!("{}.script", s.calls);
    fs::write(&s.osascript, format!("#!/bin/sh\nprintf '%s' \"$2\" > \"{saved}\"\n")).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(open_in_outlook(&s.mails[0], &s.osascript));
    assert_eq!(json!(fs::read_to_string(&saved).unwrap()), f["script"]);
}

struct NoNote;
impl NoteFile for NoNote {
    fn rel(&self) -> &str {
        ""
    }
    fn title(&self) -> &str {
        ""
    }
}

/// The fix: after an email list, "open number two" searches Outlook for that email (JS crashed here).
#[tokio::test]
async fn open_number_two_after_email_list_searches_outlook() {
    std::env::set_var("TZ", "Asia/Amman");
    let f = fixture();
    let s = setup(&f, "pick");
    let files = files();
    let job = MailJob { query: "about the budget".into(), open: false };
    run_email_search(&job, &s.mails, &files, &s.osascript, f["now"].as_i64().unwrap()).await;
    fs::write(&s.calls, "").unwrap();
    let pick = OpenJob { name: "number two".into(), explicit: false };
    let out = files.run_open_file::<NoNote>(&pick, &[], &[], &Help::default()).await;
    assert_eq!(out.as_deref(), Some("I searched Outlook for Budget draft v2. It should be at the top."));
    assert_eq!(fs::read_to_string(&s.calls).unwrap(), "Budget draft v2\n");
}
