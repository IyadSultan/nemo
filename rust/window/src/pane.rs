//! The Browser tab's web view, and its line to the browser agent.
//!
//! The view is a second WebKit view placed over the Browser tab's empty area
//! (the page sends where that area is). The agent in the Rust server
//! (rust/src/browser/pane.rs) drives it through GET /browser/pane, a WebSocket
//! this window keeps open in the background and reopens when the server restarts.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

const PANE_URL: &str = "ws://127.0.0.1:3001/browser/pane";

/// Runs in every page of the Browser tab. A dialog there would wait for a person who may not
/// be watching, so alert() is ignored and confirm() says yes; a new window opens in the tab.
pub const INIT: &str = r#"
window.alert = () => {};
window.confirm = () => true;
window.prompt = (_m, d) => (d == null ? "" : String(d));
"#;

/// Where replies go: the current connection to the server, if any.
pub type Replies = Arc<Mutex<Option<UnboundedSender<String>>>>;

pub fn reply(replies: &Replies, id: &Value, result: Result<Value, String>) {
    let msg = match result {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    if let Some(tx) = replies.lock().unwrap().as_ref() {
        let _ = tx.send(msg.to_string());
    }
}

fn token_file() -> PathBuf {
    let root = std::env::var("BRAIN_ROOT").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    root.join("second-brain/tmp/team.token")
}

/// Keep a connection to the server open. Each command it sends goes to `on_command`.
pub fn connect(replies: Replies, on_command: impl Fn(Value) + Send + 'static) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            use futures_util::{SinkExt, StreamExt};
            use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
            loop {
                // The server makes a new token each time it starts, so read it every time.
                let token = std::fs::read_to_string(token_file()).unwrap_or_default();
                let mut req = PANE_URL.into_client_request().unwrap();
                if let Ok(v) = token.trim().parse() {
                    req.headers_mut().insert("x-team-token", v);
                }
                if let Ok((ws, _)) = tokio_tungstenite::connect_async(req).await {
                    let (mut sink, mut stream) = ws.split();
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                    *replies.lock().unwrap() = Some(tx);
                    let writer = tokio::spawn(async move {
                        while let Some(text) = rx.recv().await {
                            if sink.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    });
                    while let Some(Ok(msg)) = stream.next().await {
                        if let Message::Text(text) = msg {
                            if let Ok(cmd) = serde_json::from_str::<Value>(&text) {
                                on_command(cmd);
                            }
                        }
                    }
                    *replies.lock().unwrap() = None;
                    writer.abort();
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    });
}

/// A JPEG of part of the screen (points, from the top left of the main screen), as base64.
pub fn screenshot(x: f64, y: f64, w: f64, h: f64) -> Result<Value, String> {
    use base64::Engine;
    let file = std::env::temp_dir().join(format!("second-brain-pane-{}.jpg", std::process::id()));
    let ok = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "jpg", &format!("-R{},{},{},{}", x.round(), y.round(), w.round(), h.round())])
        .arg(&file)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let bytes = std::fs::read(&file).ok().filter(|b| ok && !b.is_empty());
    let _ = std::fs::remove_file(&file);
    bytes
        .map(|b| json!(base64::engine::general_purpose::STANDARD.encode(b)))
        .ok_or_else(|| "Could not take a picture of the browser tab.".to_string())
}
