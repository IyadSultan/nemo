//! Golden test: Rust learnings must match `second-brain/learnings.js`,
//! including learnings.md after every change.
//! Fixture comes from `node rust/tests/fixtures/gen_learnings.mjs`.

use nemo_realtime_voice::learnings::*;
use serde_json::{json, Value};
use std::fs;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/learnings.json")).unwrap()
}

#[test]
fn spoken_requests_match_node() {
    for p in fixture()["parses"].as_array().unwrap() {
        assert_eq!(json!(learning_job(p["q"].as_str().unwrap())), p["out"], "question {}", p["q"]);
    }
}

#[test]
fn answers_and_file_match_node() {
    let f = fixture();
    let dir = std::env::temp_dir().join(format!("learnings-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("learnings.md");
    let l = Learnings::new(file.clone());

    for s in f["steps"].as_array().unwrap() {
        let step = &s["step"];
        let out = match step[0].as_str().unwrap() {
            "block" => json!(l.block()),
            "run" => {
                let job = &step[1];
                let text = job["text"].as_str().unwrap_or("").to_string();
                let job = match job["kind"].as_str().unwrap() {
                    "list" => LearningJob::List,
                    "add" => LearningJob::Add { text },
                    _ => LearningJob::Forget { text },
                };
                json!(l.run(&job).unwrap())
            }
            "site" => json!(l.site_shortcut(step[1].as_str().unwrap())),
            _ => {
                let texts: Vec<&str> = step[2].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
                json!(closest_index(step[1].as_str().unwrap(), &texts).map_or(-1, |i| i as i64))
            }
        };
        assert_eq!(out, s["out"], "step {step}");
        let text = fs::read_to_string(&file).ok();
        assert_eq!(json!(text), s["file"], "learnings.md after {step}");
    }

    fs::write(&file, f["big"]["file"].as_str().unwrap()).unwrap();
    assert_eq!(json!(l.block()), f["big"]["block"], "size limits");
}

/// Manual check on the real file (prints nothing personal): LEARNINGS=... LB_OUT=... cargo test -- --ignored real_file
#[test]
#[ignore]
fn real_file() {
    let l = Learnings::new(std::env::var("LEARNINGS").unwrap().into());
    fs::write(std::env::var("LB_OUT").unwrap(), l.block()).unwrap();
}
