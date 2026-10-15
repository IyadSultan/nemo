//! Rust port of the root `server.js` — small local server for the OpenAI
//! Realtime voice chatbot.
//!
//! Why this exists:
//! - Your secret OpenAI API key must stay on the server (never in the browser).
//! - The browser sends a WebRTC "offer" (SDP). We forward it to OpenAI with
//!   your key + session settings, then return OpenAI's "answer" to the browser.

use axum::{
    extract::{Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tower_http::services::ServeDir;

const MODEL: &str = "gpt-realtime-2.1-mini";
const DEFAULT_VOICE: &str = "marin";
const OPENAI_CALLS_URL: &str = "https://api.openai.com/v1/realtime/calls";

#[derive(Clone)]
struct AppState {
    api_key: Option<String>,
    calls_url: String,
    http: reqwest::Client,
}

/// Build the Realtime session config OpenAI expects.
/// semantic_vad = smarter turn-taking (when you finish speaking / interrupt).
fn build_session_config(voice: &str) -> Value {
    let instructions = [
        "You are Nemo, a friendly real-time voice assistant.",
        "Speak naturally in short turns, like a phone call.",
        "Prefer clear, warm spoken English unless the user uses another language.",
        "If interrupted, stop and listen, then respond to the new request.",
        "Ask one short clarifying question when something important is unclear.",
    ]
    .join(" ");
    json!({
        "type": "realtime",
        "model": MODEL,
        "output_modalities": ["audio"],
        "instructions": instructions,
        "audio": {
            "input": {
                "turn_detection": { "type": "semantic_vad", "interrupt_response": true },
                "transcription": { "model": "gpt-4o-mini-transcribe" }
            },
            "output": { "voice": voice }
        }
    })
}

/// Stable hashed id for OpenAI safety tooling (not a login system).
fn safety_id(api_key: &str) -> String {
    let tail: String = {
        let chars: Vec<char> = api_key.chars().collect();
        chars[chars.len().saturating_sub(8)..].iter().collect()
    };
    let digest = Sha256::digest(format!("nemo-local-{tail}").as_bytes());
    hex::encode(digest)[..32].to_string()
}

fn safe_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

#[derive(Deserialize)]
struct SessionQuery {
    voice: Option<String>,
}

/// POST /session — body: SDP offer, query: ?voice=marin, returns SDP answer.
async fn session(
    State(state): State<AppState>,
    Query(q): Query<SessionQuery>,
    sdp: String,
) -> Response {
    let Some(api_key) = state.api_key.as_deref() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Missing OPENAI_API_KEY. Copy .env.example to .env and add your key." })),
        )
            .into_response();
    };

    if !sdp.contains("v=0") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Expected an SDP offer in the request body." })),
        )
            .into_response();
    }

    let voice = q.voice.unwrap_or_else(|| DEFAULT_VOICE.to_string());
    let form = reqwest::multipart::Form::new()
        .text("sdp", sdp)
        .text("session", build_session_config(&voice).to_string());

    let upstream = state
        .http
        .post(&state.calls_url)
        .bearer_auth(api_key)
        .header("OpenAI-Safety-Identifier", safety_id(api_key))
        .multipart(form)
        .send()
        .await;

    let result = match upstream {
        Ok(r) => {
            let status = r.status();
            r.text().await.map(|body| (status, body))
        }
        Err(e) => Err(e),
    };

    match result {
        Ok((status, answer)) if status.is_success() => {
            ([(header::CONTENT_TYPE, "application/sdp")], answer).into_response()
        }
        Ok((status, answer)) => {
            // Full reply stays in the log. The browser only hears that the call failed.
            eprintln!(
                "OpenAI /realtime/calls failed: {} {}",
                status.as_u16(),
                redact_secrets(&answer)
            );
            let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (
                code,
                Json(json!({
                    "error": "OpenAI Realtime session failed",
                    "status": status.as_u16(),
                })),
            )
                .into_response()
        }
        Err(err) => {
            eprintln!("Session creation error: {}", redact_secrets(&err.to_string()));
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Failed to create Realtime session" })),
            )
                .into_response()
        }
    }
}

/// Health check so you can confirm the server is up.
async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "ok": true, "model": MODEL, "hasApiKey": state.api_key.is_some() }))
}

/// Hidden files (names starting with a dot) are not sent to the browser.
async fn hide_dotfiles(req: Request, next: Next) -> Response {
    let hidden = req.uri().path().split('/').any(|seg| seg.starts_with('.') && seg != "." && seg != "..");
    if hidden {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    next.run(req).await
}

/// Hide key-shaped text before it is written to a log. The OpenAI call is unchanged.
fn redact_secrets(text: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&['s', 'k', '-']) {
            let rest = &chars[i + 3..];
            let n = rest.iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '_' || **c == '-').count();
            if n >= 8 {
                out.push_str("sk-hidden");
                i += 3 + n;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn app(state: AppState, public_dir: PathBuf) -> Router {
    Router::new()
        .route("/session", post(session))
        .route("/health", get(health))
        .fallback_service(ServeDir::new(public_dir))
        .layer(middleware::from_fn(hide_dotfiles))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    // Shares the repo-root .env and public/ folder with the Node server.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let _ = dotenvy::from_path(root.join(".env"));

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let api_key = std::env::var("OPENAI_API_KEY").ok().filter(|k| !k.is_empty());
    let has_key = api_key.is_some();
    let state = AppState { api_key, calls_url: OPENAI_CALLS_URL.into(), http: reqwest::Client::new() };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("\nNemo Realtime Voice (Rust) → http://localhost:{port}");
    if has_key {
        println!("API key loaded. Open the URL above and press Start talking.\n");
    } else {
        eprintln!("⚠️  OPENAI_API_KEY is not set. Copy .env.example to .env first.\n");
    }
    axum::serve(listener, app(state, root.join("public"))).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app(api_key: Option<&str>, calls_url: &str) -> Router {
        let state = AppState {
            api_key: api_key.map(String::from),
            calls_url: calls_url.into(),
            http: reqwest::Client::new(),
        };
        app(state, PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public"))
    }

    async fn call(app: Router, req: Request<Body>) -> (StatusCode, String) {
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn post_sdp(body: &str) -> Request<Body> {
        Request::post("/session")
            .header("content-type", "application/sdp")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn health_reports_model_and_key() {
        let (s, b) = call(test_app(Some("sk-x"), ""), Request::get("/health").body(Body::empty()).unwrap()).await;
        assert_eq!(s, StatusCode::OK);
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v, json!({ "ok": true, "model": MODEL, "hasApiKey": true }));
    }

    #[tokio::test]
    async fn session_without_key_is_500() {
        let (s, b) = call(test_app(None, ""), post_sdp("v=0\r\n")).await;
        assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(b.contains("Missing OPENAI_API_KEY"));
    }

    #[tokio::test]
    async fn session_rejects_non_sdp() {
        let (s, b) = call(test_app(Some("sk-x"), ""), post_sdp("hello")).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(b.contains("Expected an SDP offer"));
    }

    #[tokio::test]
    async fn serves_static_index() {
        let (s, b) = call(test_app(None, ""), Request::get("/").body(Body::empty()).unwrap()).await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains("<html") || b.contains("<!DOCTYPE") || b.contains("<!doctype"));
    }

    #[test]
    fn safety_id_matches_node() {
        // Node: sha256("nemo-local-" + key.slice(-8)).hex.slice(0,32)
        let expected = "eefbc927f87c22dd9cfa675c0fe2a728"; // from Node crypto
        assert_eq!(safety_id("sk-123abcdefgh"), expected);
        assert_eq!(safety_id("sk-123abcdefgh").len(), 32);
    }

    #[test]
    fn session_config_uses_voice() {
        let c = build_session_config("cedar");
        assert_eq!(c["audio"]["output"]["voice"], "cedar");
        assert_eq!(c["model"], MODEL);
        assert_eq!(c["audio"]["input"]["turn_detection"]["type"], "semantic_vad");
    }

    #[tokio::test]
    async fn hidden_files_are_not_served() {
        let (s, _) = call(
            test_app(None, ""),
            Request::get("/.claude/logs.md").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[test]
    fn redact_hides_a_key() {
        assert_eq!(redact_secrets("bad sk-proj-abcdefghij end"), "bad sk-hidden end");
        assert_eq!(redact_secrets("no key here"), "no key here");
    }

    #[test]
    fn safe_json_falls_back_to_string() {
        assert_eq!(safe_json("{\"a\":1}"), json!({ "a": 1 }));
        assert_eq!(safe_json("not json"), json!("not json"));
    }
}
