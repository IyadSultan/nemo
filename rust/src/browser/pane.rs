//! The app's own browser: a WebKit view in the Browser tab of the Second Brain window (rust/window).
//!
//! The window connects to GET /browser/pane (a WebSocket) when it starts. The agent sends it
//! commands, one JSON object each, and the window answers with the same `id`:
//!   {"id":1,"op":"eval","js":"..."}   → {"id":1,"ok":true,"value":"<JSON text>"}
//!   {"id":2,"op":"navigate","url":"…"} {"id":3,"op":"screenshot"} (value: base64 JPEG)
//!   {"id":4,"op":"show"}  (open the Browser tab so the user can watch)
//! WebKit has no DevTools protocol here, so clicks and typing are made in JavaScript.

use super::page::{Key, Page, Tab};
use async_trait::async_trait;
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Helpers the pane's commands use; defined again on every new page.
const PANE_JS: &str = include_str!("pane.js");
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

struct Conn {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicU64,
}

/// The window that is connected now, if any.
static PANE: Mutex<Option<Arc<Conn>>> = Mutex::new(None);

pub fn connected() -> bool {
    PANE.lock().unwrap().is_some()
}

/// Serve one window. A newer window replaces an older one.
pub async fn serve(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
    let conn = Arc::new(Conn { out, pending: Mutex::default(), next: AtomicU64::new(1) });
    *PANE.lock().unwrap() = Some(conn.clone());
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(id) = v["id"].as_u64() else { continue };
        if let Some(tx) = conn.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(if v["ok"] == true { Ok(v["value"].clone()) } else { Err(v["error"].as_str().unwrap_or("The app's browser failed.").to_string()) });
        }
    }
    writer.abort();
    let mut pane = PANE.lock().unwrap();
    if pane.as_ref().is_some_and(|c| Arc::ptr_eq(c, &conn)) {
        *pane = None;
    }
}

async fn call(conn: &Conn, mut cmd: Value) -> Result<Value, String> {
    let id = conn.next.fetch_add(1, Ordering::Relaxed);
    cmd["id"] = json!(id);
    let (tx, rx) = oneshot::channel();
    conn.pending.lock().unwrap().insert(id, tx);
    conn.out.send(cmd.to_string()).map_err(|_| "The app window closed.".to_string())?;
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("The app window closed.".into()),
        Err(_) => {
            conn.pending.lock().unwrap().remove(&id);
            Err("The app's browser did not answer in time.".into())
        }
    }
}

/// The browser tab in the app window.
pub struct PanePage {
    conn: Arc<Conn>,
}

impl PanePage {
    /// The connected window's browser, shown so the user can watch. None if the app is not open.
    pub async fn open() -> Option<PanePage> {
        let conn = PANE.lock().unwrap().clone()?;
        let page = PanePage { conn };
        call(&page.conn, json!({ "op": "show" })).await.ok()?;
        Some(page)
    }

    /// Run `body` (an expression) with the pane helpers defined, catching errors in the page.
    pub fn wrap(body: &str) -> String {
        format!(
            "JSON.stringify((() => {{ {PANE_JS}\ntry {{ return {{ ok: true, v: ({body}\n) }}; }} catch (e) {{ return {{ ok: false, e: String((e && e.message) || e) }}; }} }})())"
        )
    }
}

/// The address the app's browser is showing, if the app is open on a real page.
pub async fn current_url() -> Option<String> {
    let conn = PANE.lock().unwrap().clone()?;
    let page = PanePage { conn };
    let url = page.url().await;
    (url.starts_with("http")).then_some(url)
}

/// WebKit hands back the script's value as JSON text; our script's value is itself JSON text.
pub fn unwrap_value(raw: &Value) -> Result<Value, String> {
    let mut v = raw.clone();
    for _ in 0..2 {
        match v {
            Value::String(s) => v = serde_json::from_str(&s).unwrap_or(Value::Null),
            _ => break,
        }
    }
    if v["ok"] == true {
        Ok(v.get("v").cloned().unwrap_or(Value::Null))
    } else if v.is_null() {
        // The page was changing while the script ran.
        Err("The page was still loading.".into())
    } else {
        Err(v["e"].as_str().unwrap_or("script error").to_string())
    }
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

#[async_trait]
impl Page for PanePage {
    async fn eval(&self, expression: &str) -> Result<Value, String> {
        let raw = call(&self.conn, json!({ "op": "eval", "js": Self::wrap(expression) })).await?;
        unwrap_value(&raw)
    }

    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        // A mark on the old page tells when the new one has replaced it.
        let _ = self.eval("window.__brainOld = true").await;
        call(&self.conn, json!({ "op": "navigate", "url": url })).await?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(15) {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Ok(v) = self.eval("!window.__brainOld && document.readyState === 'complete'").await {
                if v == true {
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        Ok(())
    }

    async fn new_tab(&mut self, url: &str) -> Result<(), String> {
        // One tab only: the page opens in it.
        self.navigate(url).await
    }

    async fn tabs(&self) -> Result<Vec<Tab>, String> {
        let v = self.eval("({ url: location.href, title: document.title })").await.unwrap_or_default();
        Ok(vec![Tab { id: "pane".into(), url: v["url"].as_str().unwrap_or("").into(), title: v["title"].as_str().unwrap_or("").into() }])
    }

    fn current(&self) -> String {
        "pane".into()
    }

    async fn switch(&mut self, id: &str) -> Result<(), String> {
        if id == "pane" {
            Ok(())
        } else {
            Err("The app's browser has one tab.".into())
        }
    }

    async fn close_tab(&mut self, _id: &str) -> Result<(), String> {
        Err("The app's browser has one tab; navigate instead of closing it.".into())
    }

    async fn click_at(&self, x: f64, y: f64) -> Result<(), String> {
        let v = self.eval(&format!("__brainPane.click({x}, {y})")).await?;
        if v == false {
            return Err("Nothing to click there.".into());
        }
        Ok(())
    }

    async fn insert_text(&self, text: &str) -> Result<(), String> {
        self.eval(&format!("__brainPane.type({})", js_str(text))).await.map(|_| ())
    }

    async fn key(&self, k: &Key) -> Result<(), String> {
        let spec = json!({ "key": k.key, "code": k.code, "keyCode": k.key_code, "text": k.text, "modifiers": k.modifiers });
        self.eval(&format!("__brainPane.key({spec})")).await.map(|_| ())
    }

    async fn upload(&self, _index: usize, _path: &str) -> Result<(), String> {
        Err("The app's browser cannot attach files. Tell the user to attach it by hand, then continue.".into())
    }

    async fn screenshot(&self) -> Result<Vec<u8>, String> {
        use base64::Engine;
        let v = call(&self.conn, json!({ "op": "screenshot" })).await?;
        base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap_or("")).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_webkit_values() {
        // WebKit's JSON of our JSON.stringify result.
        let raw = json!("{\"ok\":true,\"v\":{\"a\":1}}");
        assert_eq!(unwrap_value(&raw).unwrap(), json!({ "a": 1 }));
        assert_eq!(unwrap_value(&json!("{\"ok\":true}")).unwrap(), Value::Null);
        assert_eq!(unwrap_value(&json!("{\"ok\":false,\"e\":\"boom\"}")).unwrap_err(), "boom");
        assert!(unwrap_value(&Value::Null).is_err());
    }
}
