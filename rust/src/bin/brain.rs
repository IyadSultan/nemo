//! The second brain's front door, in Rust.
//!
//! It listens where the Node server used to (port 3001) and answers the
//! requests whose code is already in Rust. Everything else goes, unchanged
//! and streamed, to the Node server, which now runs on port 3002.
//! Each later step moves more routes here, until Node is not needed.
//!
//! Every response carries `x-served-by: rust` or `x-served-by: node`.
//! GET /rust lists what Rust handles today.
//!
//! Desk routes stay in Node for now: Node keeps desk.json in memory and
//! changes it in the background, so two writers would lose each other's edits.

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hyper_util::{client::legacy::connect::HttpConnector, client::legacy::Client, rt::TokioExecutor};
use nemo_realtime_voice::{clock, js, medgem::Medgem, pricing, team};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::os::unix::fs::OpenOptionsExt;
use tokio_stream::StreamExt as _;
use tower::ServiceExt;
use tower_http::services::ServeDir;

/// What Rust answers itself. Shown at GET /rust.
const RUST_ROUTES: &[&str] = &[
    "GET /models",
    "POST /medgem/warm",
    "POST /medgem/clean",
    "GET /here",
    "POST /meeting/folder",
    "POST /team/ask (helper team on AutoAgents; Node only)",
    "static files (public/, /vendor/rive)",
];

const SERVED_BY: HeaderName = HeaderName::from_static("x-served-by");

#[derive(Clone)]
struct AppState {
    node: String,
    client: Client<HttpConnector, Body>,
    medgem: Arc<Medgem>,
    public: PathBuf,
    rive: PathBuf,
    /// Secret for /team/ask, made at start and written where only Node reads it.
    team_token: Arc<String>,
}

fn mark(mut res: Response, who: &'static str) -> Response {
    res.headers_mut().insert(SERVED_BY, HeaderValue::from_static(who));
    res
}

async fn models() -> Response {
    let all: Vec<&pricing::Model> = pricing::VOICE_MODELS.iter().chain(pricing::MODELS).collect();
    mark(Json(json!({ "models": all, "reasoning": pricing::REASONING_LEVELS })).into_response(), "rust")
}

async fn medgem_warm(State(s): State<AppState>) -> Response {
    tokio::spawn(async move {
        if let Err(err) = s.medgem.warm().await {
            eprintln!("Failed while loading GPT-OSS: {err}");
        }
    });
    mark(Json(json!({ "ok": true })).into_response(), "rust")
}

/// Like express.json(): only a JSON body is read; anything else counts as empty.
fn json_body(headers: &axum::http::HeaderMap, body: &Bytes) -> Value {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.to_ascii_lowercase().starts_with("application/json"));
    if is_json {
        serde_json::from_slice(body).unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

async fn medgem_clean(State(s): State<AppState>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    let body = json_body(&headers, &body);
    let text = match body["text"].as_str() {
        Some(t) => js::slice16(js::trim(t), 0, 4000),
        None => String::new(),
    };
    let res = if text.is_empty() {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": "No words to clean." }))).into_response()
    } else {
        match s.medgem.clean_medical(&text).await {
            Ok(cleaned) => Json(cleaned).into_response(),
            Err(err) => {
                eprintln!("Failed while cleaning medical speech: {err}");
                (StatusCode::BAD_GATEWAY, Json(json!({ "error": "GPT-OSS could not clean that." }))).into_response()
            }
        }
    };
    mark(res, "rust")
}

async fn here() -> Response {
    let now = chrono::Utc::now().timestamp_millis();
    mark(Json(json!({ "text": clock::here_and_now(now, &clock::zone_name()) })).into_response(), "rust")
}

/// Ask macOS for a folder. Returns an empty path if the user cancels.
async fn meeting_folder(headers: axum::http::HeaderMap, body: Bytes) -> Response {
    let body = json_body(&headers, &body);
    let prompt = if body["kind"] == "lecture" { "Save the lecture notes in:" } else { "Save the meeting minutes in:" };
    let script = format!("POSIX path of (choose folder with prompt {})", serde_json::to_string(prompt).unwrap());
    let out = tokio::process::Command::new("osascript").args(["-e", &script]).output().await;
    let folder = match out {
        Ok(o) if o.status.success() => js::trim(&String::from_utf8_lossy(&o.stdout)).to_string(),
        _ => String::new(),
    };
    mark(Json(json!({ "folder": folder })).into_response(), "rust")
}

/// Run a helper team for one answer (src/team.rs). Only Node may call this:
/// it sends the token from second-brain/tmp/team.token. Answers as an event stream.
async fn team_ask(State(s): State<AppState>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    let given = headers.get("x-team-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if s.team_token.is_empty() || given != s.team_token.as_str() {
        return mark((StatusCode::FORBIDDEN, Json(json!({ "error": "Not allowed." }))).into_response(), "rust");
    }
    let req: team::Request = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return mark((StatusCode::BAD_REQUEST, Json(json!({ "error": "Bad team request." }))).into_response(), "rust"),
    };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    tokio::spawn(team::run(req, tx));
    let events = tokio_stream::wrappers::UnboundedReceiverStream::new(rx)
        .map(|v| Ok::<_, std::convert::Infallible>(Bytes::from(format!("data: {v}\n\n"))));
    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(events))
        .unwrap();
    mark(res, "rust")
}

/// A fresh random token, saved for Node (owner-only file).
fn make_team_token(repo: &std::path::Path) -> String {
    let mut bytes = [0u8; 24];
    if getrandom::fill(&mut bytes).is_err() {
        return String::new();
    }
    let token = hex::encode(bytes);
    let dir = repo.join("second-brain").join("tmp");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("team.token");
    let _ = std::fs::remove_file(&path);
    let saved = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, token.as_bytes()));
    if let Err(err) = saved {
        eprintln!("Could not save the team token ({err}); the helper team is off.");
        return String::new();
    }
    token
}

async fn status(State(s): State<AppState>) -> Response {
    mark(Json(json!({ "rust": RUST_ROUTES, "everything_else": s.node })).into_response(), "rust")
}

/// Hop-by-hop headers belong to one connection and are not forwarded.
fn hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "transfer-encoding" | "te" | "trailer" | "upgrade"
    )
}

fn strip(headers: &mut axum::http::HeaderMap, drop_host: bool) {
    let names: Vec<HeaderName> =
        headers.keys().filter(|n| hop_by_hop(n) || (drop_host && **n == header::HOST)).cloned().collect();
    for name in names {
        headers.remove(name);
    }
}

/// Send the request to Node as-is and stream the answer back (works for text/event-stream).
async fn to_node(s: &AppState, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let path = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    parts.uri = match format!("{}{path}", s.node).parse::<Uri>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "Bad address").into_response(),
    };
    strip(&mut parts.headers, true);
    match s.client.request(Request::from_parts(parts, body)).await {
        Ok(res) => {
            let (mut parts, body) = res.into_parts();
            strip(&mut parts.headers, false);
            mark(Response::from_parts(parts, Body::new(body)), "node")
        }
        Err(err) => {
            eprintln!("Failed while passing a request to the Node brain server: {err}");
            let res = (StatusCode::BAD_GATEWAY, Json(json!({ "error": "The Node brain server is not answering." })));
            mark(res.into_response(), "rust")
        }
    }
}

/// Files from public/ (as express.static did), else Node.
/// Dot-files and dot-folders are never served (Node's static server did serve them).
async fn files_or_node(State(s): State<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let hidden = path.split('/').any(|seg| seg.starts_with('.'));
    if hidden {
        // Node's express.static served these (public/.claude/logs.md, the session log). Not any more.
        return mark((StatusCode::NOT_FOUND, "Not found").into_response(), "rust");
    }
    let is_read = req.method() == axum::http::Method::GET || req.method() == axum::http::Method::HEAD;
    if is_read {
        let (dir, sub) = match path.strip_prefix("/vendor/rive") {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => (&s.rive, rest.to_string()),
            _ => (&s.public, path.clone()),
        };
        let mut file_req = Request::new(Body::empty());
        *file_req.uri_mut() = if sub.is_empty() { "/".parse().unwrap() } else { sub.parse().unwrap_or_else(|_| "/".parse().unwrap()) };
        *file_req.method_mut() = req.method().clone();
        let mut res = ServeDir::new(dir).oneshot(file_req).await.unwrap_or_else(|never| match never {});
        if res.status() != StatusCode::NOT_FOUND {
            // As express.static did: check for a newer copy every time. Without it,
            // WebKit kept old pages for hours after they changed.
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=0"));
            return mark(res.map(Body::new), "rust");
        }
    }
    to_node(&s, req).await
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/models", get(models))
        .route("/medgem/warm", post(medgem_warm))
        .route("/medgem/clean", post(medgem_clean))
        .route("/here", get(here))
        .route("/meeting/folder", post(meeting_folder))
        .route("/team/ask", post(team_ask))
        .route("/rust", get(status))
        .fallback(files_or_node)
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let repo = std::env::var("BRAIN_ROOT").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    let _ = dotenvy::from_path(repo.join(".env"));
    let port: u16 = std::env::var("BRAIN_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3001);
    let node = std::env::var("NODE_URL").unwrap_or_else(|_| "http://127.0.0.1:3002".into());
    let state = AppState {
        client: Client::builder(TokioExecutor::new()).build(HttpConnector::new()),
        node: node.trim_end_matches('/').to_string(),
        medgem: Arc::new(Medgem::from_env()),
        public: repo.join("second-brain").join("public"),
        rive: repo.join("node_modules").join("@rive-app").join("canvas"),
        team_token: Arc::new(make_team_token(&repo)),
    };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap_or_else(|e| panic!("port {port}: {e}"));
    println!("Second brain (Rust front) → http://localhost:{port}  (everything not yet in Rust goes to {node})");
    axum::serve(listener, app(state)).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A stand-in for the Node server.
    async fn fake_node() -> String {
        use axum::extract::Query;
        let app = Router::new()
            .route("/echo", post(|req: Request| async move {
                let method = req.method().to_string();
                let custom = req.headers().get("x-custom").map(|v| v.to_str().unwrap().to_string());
                let q = req.uri().query().unwrap_or("").to_string();
                let body = axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap();
                Json(json!({ "method": method, "custom": custom, "query": q, "body": String::from_utf8_lossy(&body) }))
            }))
            .route("/stream", get(|| async {
                let chunks = async_stream(vec!["data: one\n\n", "data: two\n\n"]);
                ([(header::CONTENT_TYPE, "text/event-stream")], Body::from_stream(chunks))
            }))
            .route("/moved", get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/elsewhere")]) }))
            .route("/health", get(|Query(_q): Query<Value>| async { Json(json!({ "ok": true, "from": "node" })) }))
            .fallback(|| async { (StatusCode::NOT_FOUND, "node 404") });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    /// Chunks 300 ms apart, to check that the proxy does not wait for the end.
    fn async_stream(chunks: Vec<&'static str>) -> impl futures_core::Stream<Item = Result<Bytes, std::io::Error>> {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tokio::spawn(async move {
            for c in chunks {
                let _ = tx.send(Ok(Bytes::from_static(c.as_bytes()))).await;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });
        tokio_stream::wrappers::ReceiverStream::new(rx)
    }

    async fn front(node: String, public: PathBuf) -> String {
        let state = AppState {
            client: Client::builder(TokioExecutor::new()).build(HttpConnector::new()),
            node,
            medgem: Arc::new(Medgem::new("http://127.0.0.1:9")),
            public,
            rive: PathBuf::from("/nonexistent"),
            team_token: Arc::new("test-token".into()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
        url
    }

    fn public_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brain-front-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>home</html>").unwrap();
        std::fs::write(dir.join("app.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join(".claude/logs.md"), "private").unwrap();
        dir
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
    }

    #[tokio::test]
    async fn serves_files_and_rust_routes_itself() {
        let base = front(fake_node().await, public_dir()).await;
        let res = client().get(format!("{base}/")).send().await.unwrap();
        assert_eq!(res.headers()["x-served-by"], "rust");
        assert_eq!(res.headers()["cache-control"], "public, max-age=0");
        assert_eq!(res.text().await.unwrap(), "<html>home</html>");
        let res = client().get(format!("{base}/models")).send().await.unwrap();
        assert_eq!(res.headers()["x-served-by"], "rust");
        let v: Value = res.json().await.unwrap();
        assert_eq!(v["models"].as_array().unwrap().len(), pricing::VOICE_MODELS.len() + pricing::MODELS.len());
        let res = client().post(format!("{base}/medgem/clean")).json(&json!({ "text": "  " })).send().await.unwrap();
        assert_eq!(res.status(), 400);
        assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "No words to clean." }));
        // Ollama is not running at the test address: the same 502 as Node.
        let res = client().post(format!("{base}/medgem/clean")).json(&json!({ "text": "fever" })).send().await.unwrap();
        assert_eq!(res.status(), 502);
    }

    #[tokio::test]
    async fn hidden_files_are_never_served() {
        let base = front(fake_node().await, public_dir()).await;
        for path in ["/.claude/logs.md", "/.env", "/x/.git/config"] {
            let res = client().get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(res.status(), 404, "{path}");
            assert_eq!(res.headers()["x-served-by"], "rust", "{path}");
        }
    }

    #[tokio::test]
    async fn passes_everything_else_to_node_unchanged() {
        let base = front(fake_node().await, public_dir()).await;
        let res = client()
            .post(format!("{base}/echo?a=1&b=two"))
            .header("x-custom", "kept")
            .body("hello body")
            .send()
            .await
            .unwrap();
        assert_eq!(res.headers()["x-served-by"], "node");
        assert_eq!(
            res.json::<Value>().await.unwrap(),
            json!({ "method": "POST", "custom": "kept", "query": "a=1&b=two", "body": "hello body" })
        );
        // Redirects reach the browser as they are.
        let res = client().get(format!("{base}/moved")).send().await.unwrap();
        assert_eq!(res.status(), 302);
        assert_eq!(res.headers()["location"], "/elsewhere");
        // Node's own 404 for unknown paths.
        let res = client().get(format!("{base}/nothing-here")).send().await.unwrap();
        assert_eq!((res.status().as_u16(), res.text().await.unwrap()), (404, "node 404".to_string()));
    }

    #[tokio::test]
    async fn streams_arrive_as_they_are_sent() {
        let base = front(fake_node().await, public_dir()).await;
        let started = Instant::now();
        let mut res = client().get(format!("{base}/stream")).send().await.unwrap();
        let first = res.chunk().await.unwrap().unwrap();
        let first_at = started.elapsed();
        assert_eq!(first, "data: one\n\n");
        assert!(first_at < Duration::from_millis(250), "first chunk took {first_at:?}");
        assert_eq!(res.chunk().await.unwrap().unwrap(), "data: two\n\n");
    }

    #[tokio::test]
    async fn node_down_gives_a_clear_502() {
        let base = front("http://127.0.0.1:9".into(), public_dir()).await;
        let res = client().get(format!("{base}/health")).send().await.unwrap();
        assert_eq!(res.status(), 502);
        assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "The Node brain server is not answering." }));
    }

    #[tokio::test]
    async fn team_needs_nodes_token() {
        let base = front("http://127.0.0.1:9".into(), public_dir()).await;
        let res = client().post(format!("{base}/team/ask")).json(&json!({ "system": "", "prompt": "hi" })).send().await.unwrap();
        assert_eq!(res.status(), 403);
        let res = client().post(format!("{base}/team/ask")).header("x-team-token", "wrong").body("{}").send().await.unwrap();
        assert_eq!(res.status(), 403);
        let res = client().post(format!("{base}/team/ask")).header("x-team-token", "test-token").body("not json").send().await.unwrap();
        assert_eq!(res.status(), 400);
    }

    /// Golden test: hereAndNow extracted from server.js (rust/tests/fixtures/gen_routes.mjs).
    #[tokio::test]
    async fn here_matches_node() {
        std::env::set_var("TZ", "Asia/Amman");
        let f: Value = serde_json::from_str(include_str!("../../tests/fixtures/routes.json")).unwrap();
        for h in f["heres"].as_array().unwrap() {
            assert_eq!(json!(clock::here_and_now(h["ms"].as_i64().unwrap(), "Asia/Amman")), h["text"]);
        }
        let base = front("http://127.0.0.1:9".into(), public_dir()).await;
        let res = client().get(format!("{base}/here")).send().await.unwrap();
        assert_eq!(res.headers()["x-served-by"], "rust");
        assert!(res.json::<Value>().await.unwrap()["text"].as_str().unwrap().starts_with("It is "));
    }
}
