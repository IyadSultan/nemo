//! Golden test: Rust meaning search must match `second-brain/embed.js`.
//! Fixture comes from `node rust/tests/fixtures/gen_embed.mjs`, which uses
//! the same fake Ollama (letter-count embeddings) as below.

use axum::{extract::State, routing::post, Json, Router};
use nemo_realtime_voice::embed::{NoteText, SemanticIndex};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct Note {
    title: String,
    text: String,
}

impl NoteText for Note {
    fn title(&self) -> &str {
        &self.title
    }
    fn text(&self) -> &str {
        &self.text
    }
}

fn fake_embedding(text: &str) -> Vec<f64> {
    let mut v = vec![0.0; 27];
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_lowercase() {
            v[(ch as u8 - b'a') as usize] += 1.0;
        }
    }
    v[26] = 1.0;
    v
}

/// Starts a fake Ollama; returns its URL and a counter of embedded inputs.
async fn fake_ollama() -> (String, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/api/embed",
            post(|State(count): State<Arc<AtomicUsize>>, Json(body): Json<Value>| async move {
                let inputs = body["input"].as_array().unwrap();
                count.fetch_add(inputs.len(), Ordering::SeqCst);
                let embeddings: Vec<_> = inputs.iter().map(|i| fake_embedding(i.as_str().unwrap())).collect();
                Json(json!({ "embeddings": embeddings }))
            }),
        )
        .with_state(count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, count)
}

fn temp_cache(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("embed-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("embeddings.json")
}

fn fixture() -> (Value, Vec<Arc<Note>>) {
    let f: Value = serde_json::from_str(include_str!("fixtures/embed.json")).unwrap();
    let notes = f["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| Arc::new(Note { title: n["title"].as_str().unwrap().into(), text: n["text"].as_str().unwrap().into() }))
        .collect();
    (f, notes)
}

#[tokio::test]
async fn cache_and_search_match_node() {
    let (f, notes) = fixture();
    let (url, _) = fake_ollama().await;
    let cache_file = temp_cache("parity");
    let index = SemanticIndex::new(&url, "embeddinggemma", cache_file.clone());
    index.build(&notes).await.unwrap();
    assert!(index.is_ready());

    // Same hashes, same vector bytes: Node and Rust can share the cache file.
    let cache: Value = serde_json::from_str(&std::fs::read_to_string(&cache_file).unwrap()).unwrap();
    assert_eq!(cache, f["cache"]);

    for s in f["searches"].as_array().unwrap() {
        let q = s["query"].as_str().unwrap();
        let want = s["hits"].as_array().unwrap();
        let limit = if q == "wwww" { 2 } else { 20 };
        let got = index.search(q, limit).await;
        assert_eq!(got.len(), want.len(), "query {q}");
        for (g, w) in got.iter().zip(want) {
            let idx = notes.iter().position(|n| Arc::ptr_eq(n, &g.note)).unwrap();
            assert_eq!(json!(idx), w["note"], "query {q}");
            assert_eq!(json!(g.score), w["score"], "query {q}");
            assert_eq!(json!(g.text), w["text"], "query {q}");
        }
    }
}

#[tokio::test]
async fn reuses_node_cache_without_embedding_again() {
    let (f, notes) = fixture();
    let (url, count) = fake_ollama().await;
    let cache_file = temp_cache("reuse");
    std::fs::create_dir_all(cache_file.parent().unwrap()).unwrap();
    std::fs::write(&cache_file, f["cache"].to_string()).unwrap();

    let index = SemanticIndex::new(&url, "embeddinggemma", cache_file);
    index.build(&notes).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cache_for_another_model_is_ignored() {
    let (f, notes) = fixture();
    let (url, count) = fake_ollama().await;
    let cache_file = temp_cache("other-model");
    std::fs::create_dir_all(cache_file.parent().unwrap()).unwrap();
    let mut other = f["cache"].clone();
    other["model"] = json!("nomic-embed-text");
    std::fs::write(&cache_file, other.to_string()).unwrap();

    let index = SemanticIndex::new(&url, "embeddinggemma", cache_file);
    index.build(&notes).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), f["cache"]["vectors"].as_object().unwrap().len());
}

#[tokio::test]
async fn search_returns_nothing_when_not_built_or_ollama_down() {
    let (_, notes) = fixture();
    let (url, _) = fake_ollama().await;
    let index = SemanticIndex::new(&url, "embeddinggemma", temp_cache("down"));
    assert!(index.search("anything", 5).await.is_empty());

    index.build(&notes).await.unwrap();
    // Port 9 (discard) has nothing listening.
    let dead = SemanticIndex::<Note>::new("http://127.0.0.1:9", "embeddinggemma", temp_cache("down2"));
    assert!(dead.build(&notes).await.is_err());
    assert!(!dead.is_ready());
    assert!(dead.search("anything", 5).await.is_empty());
}
