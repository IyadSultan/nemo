//! Golden test: Rust medical-speech cleaning must match `second-brain/medgem.js`.
//! Fixture comes from `node rust/tests/fixtures/gen_medgem.mjs`. The fake Ollama
//! below replays the replies Node got, and records what Rust sends.

use axum::{extract::State, routing::post, Json, Router};
use nemo_realtime_voice::medgem::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/medgem.json")).unwrap()
}

#[test]
fn prompt_matches_node() {
    assert_eq!(json!(prompt_for("Patient has fever.")), fixture()["helpers"]["prompt"]);
}

#[test]
fn identifier_stripping_matches_node() {
    for pair in fixture()["helpers"]["strip"].as_array().unwrap() {
        let input = pair[0].as_str().unwrap();
        assert_eq!(json!(strip_obvious_ids(input)), pair[1], "input {input:?}");
    }
}

#[test]
fn question_for_brain_matches_node() {
    for q in fixture()["helpers"]["questions"].as_array().unwrap() {
        let s = |k: &str| q[k].as_str().unwrap().to_string();
        let got = question_for_brain(&s("raw"), &s("english"), &s("fromModel"));
        assert_eq!(json!(got), q["result"], "case {q}");
    }
}

#[test]
fn think_blocks_and_json_parsing_match_node() {
    let f = fixture();
    for pair in f["helpers"]["visible"].as_array().unwrap() {
        assert_eq!(json!(visible_text(pair[0].as_str().unwrap())), pair[1]);
    }
    for p in f["helpers"]["parse"].as_array().unwrap() {
        let got = parse_cleaned(p["input"].as_str().unwrap()).ok();
        assert_eq!(json!(got), p["ok"], "input {}", p["input"]);
    }
}

type Log = Arc<Mutex<Vec<Value>>>;

/// Fake Ollama: answers each request with the reply Node got for the same prompt.
async fn replay_ollama(replies: Vec<(Value, Value)>) -> (String, Log) {
    let log: Log = Default::default();
    let app = Router::new()
        .route(
            "/api/generate",
            post(|State((replies, log)): State<(Arc<Vec<(Value, Value)>>, Log)>, Json(body): Json<Value>| async move {
                log.lock().unwrap().push(body.clone());
                let reply = replies.iter().find(|(req, _)| req["prompt"] == body["prompt"]).map(|(_, r)| r.clone());
                Json(reply.unwrap_or(json!({ "response": "{}" })))
            }),
        )
        .with_state((Arc::new(replies), log.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, log)
}

#[tokio::test]
async fn clean_medical_matches_node() {
    let f = fixture();
    for c in f["cases"].as_array().unwrap() {
        let node_requests: Vec<Value> = c["requests"].as_array().unwrap().iter().map(|r| r["body"].clone()).collect();
        let replies = c["requests"].as_array().unwrap().iter().map(|r| (r["body"].clone(), r["reply"].clone())).collect();
        let (url, log) = replay_ollama(replies).await;

        let got = Medgem::new(&url).clean_medical(c["text"].as_str().unwrap()).await.unwrap();
        let mut got = json!(got);
        got.as_object_mut().unwrap().remove("ms");
        assert_eq!(got, c["result"], "text {}", c["text"]);
        // Same calls, same bodies, same order as Node.
        assert_eq!(*log.lock().unwrap(), node_requests, "text {}", c["text"]);
    }
}

#[tokio::test]
async fn warm_request_matches_node() {
    let (url, log) = replay_ollama(vec![]).await;
    Medgem::new(&url).warm().await.unwrap();
    assert_eq!(log.lock().unwrap()[0], fixture()["warm"]);
}

#[tokio::test]
async fn ollama_down_is_an_error() {
    assert!(Medgem::new("http://127.0.0.1:9").clean_medical("fever").await.is_err());
}
