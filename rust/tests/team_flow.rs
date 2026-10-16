//! The helper team (src/team.rs) end to end, with a fake `claude` program
//! instead of Claude Code: plan, two Sonnet 5.5 helpers in parallel, a streamed lead answer.

use nemo_realtime_voice::team::{self, parse_plan, Request, HELPER_MODEL};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

const FAKE: &str = r#"#!/bin/sh
# Records its model and answers like `claude -p --output-format stream-json`.
model=""; sys=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift;;
    --system-prompt) sys="$2"; shift;;
  esac
  shift
done
cat > /dev/null
echo "$model" >> "$FAKE_LOG"
case "$sys" in
  *"Reply with JSON only"*)
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"```json {\"helpers\":[{\"task\":\"Search the notes\"},{\"task\":\"Search the email\"}]} ```"}}}';;
  *"one helper"*)
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/w/notes/plan.md"}}]}}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Found it in plan.md"}}}';;
  *)
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world."}}}';;
esac
echo '{"type":"result","is_error":false,"result":"x","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":3}}'
"#;

#[tokio::test]
async fn plan_helpers_and_streamed_answer() {
    let dir = std::env::temp_dir().join(format!("team-flow-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("claude");
    std::fs::write(&bin, FAKE).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = dir.join("models.log");
    std::env::set_var("CLAUDE_BIN", &bin);
    std::env::set_var("FAKE_LOG", &log);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let req = Request {
        system: "Answer briefly.".into(),
        prompt: "What is the plan?".into(),
        lead_model: "opus".into(),
        effort: Some("low".into()),
        dirs: vec![dir.clone()],
    };
    team::run(req, tx).await;
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }

    let team_ev = events.iter().find(|e| e["type"] == "team").expect("team event");
    assert_eq!(team_ev["model"], HELPER_MODEL);
    let names: Vec<&str> = team_ev["agents"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Ada", "Milo"]);
    assert!(events.iter().any(|e| e["type"] == "agent" && e["id"] == "ada" && e["doing"] == "Reading plan.md"));
    for id in ["ada", "milo"] {
        assert!(events.iter().any(|e| e["type"] == "agent" && e["id"] == id && e["state"] == "done"), "{id} done");
    }
    // Each helper's terminal log: its job, its tool calls, what it wrote, and the end.
    let ada_log: String = events.iter().filter(|e| e["id"] == "ada").filter_map(|e| e["log"].as_str()).collect();
    for part in ["Job: Search the notes", "› Reading plan.md", "Found it in plan.md", "✓ Done"] {
        assert!(ada_log.contains(part), "{part} missing from {ada_log:?}");
    }
    let answer: String = events.iter().filter(|e| e["type"] == "delta").map(|e| e["text"].as_str().unwrap()).collect();
    assert_eq!(answer, "Hello world.");
    assert!(!events.iter().any(|e| e["type"] == "error"));
    // Planner + 2 helpers + lead = 4 calls, each 15 in (10 + 5 cached) and 3 out.
    let t = events.iter().find(|e| e["type"] == "tokens").unwrap();
    assert_eq!(t, &json!({ "type": "tokens", "input_tokens": 60, "input_tokens_details": { "cached_tokens": 20 }, "output_tokens": 12 }));

    // Planner and helpers ran on Sonnet 5.5; only the lead used the picked model.
    let mut models: Vec<String> = std::fs::read_to_string(&log).unwrap().lines().map(String::from).collect();
    models.sort();
    assert_eq!(models, ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "opus"]);
}

#[test]
fn plans_are_read_even_with_words_around_them() {
    assert_eq!(parse_plan("no json here").helpers.len(), 0);
    assert_eq!(parse_plan("Sure: {\"helpers\": []}").helpers.len(), 0);
    let many = json!({ "helpers": (0..9).map(|i| json!({ "task": format!("job {i}") })).collect::<Vec<_>>() });
    assert_eq!(parse_plan(&many.to_string()).helpers.len(), team::MAX_HELPERS);
    assert_eq!(parse_plan("{\"helpers\":[{\"task\":\"  \"},{\"task\":\"real\"}]}").helpers.len(), 1);
}

#[test]
fn final_prompt_lists_each_helpers_findings() {
    assert_eq!(team::final_prompt("Q", &[], &[]), "Q");
    let p = team::final_prompt("Q", &[("Ada".into(), "notes".into(), " fact \n".into())], &[]);
    assert!(p.starts_with("Q\n\n---\n") && p.contains("### Ada: notes\nfact\n"));
    assert!(p.contains("Do not mention the helpers by name"));
    let p = team::final_prompt("Q", &[("Ada".into(), "notes".into(), "fact".into())], &["Ada".into()]);
    assert!(p.contains("The user asked Ada by name") && !p.contains("Do not mention"));
}

#[test]
fn a_helper_asked_by_name_gets_that_name() {
    let plan = parse_plan(r#"{"helpers":[{"task":"other job"},{"name":"milo","task":"check email"},{"name":"Zed","task":"x"}]}"#);
    let crew = team::assign_crew(&plan.helpers);
    let names: Vec<(&str, bool)> = crew.iter().map(|c| (c.0.as_str(), c.3)).collect();
    // Milo keeps his name; the unnamed job and the unknown "Zed" get the next free names.
    assert_eq!(names, [("Ada", false), ("Milo", true), ("Juno", false)]);
    assert_eq!(crew[1].2, "check email");
}
