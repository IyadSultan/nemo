//! A small Chrome DevTools Protocol client: one WebSocket to the browser,
//! with every page reached through a flat `sessionId` (Target.attachToTarget).

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Cdp {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<Value>,
}

/// How long one command may take before it counts as failed.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

impl Cdp {
    pub async fn connect(ws_url: &str) -> Result<Arc<Cdp>, String> {
        let (ws, _) = tokio_tungstenite::connect_async(ws_url).await.map_err(|e| format!("Could not reach Chrome ({e})."))?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::default();
        let (events, _) = broadcast::channel(256);
        tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });
        let (p, ev) = (pending.clone(), events.clone());
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Text(text) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v["id"].as_u64() {
                    Some(id) => {
                        if let Some(tx) = p.lock().unwrap().remove(&id) {
                            let res = match v.get("error") {
                                Some(e) => Err(e["message"].as_str().unwrap_or("CDP error").to_string()),
                                None => Ok(v["result"].clone()),
                            };
                            let _ = tx.send(res);
                        }
                    }
                    None => {
                        let _ = ev.send(v);
                    }
                }
            }
            // Chrome went away: fail every waiting command.
            p.lock().unwrap().clear();
        });
        Ok(Arc::new(Cdp { out, pending, next: AtomicU64::new(1), events }))
    }

    /// Send one command and wait for its result. `session` is a page's sessionId, or None for the browser.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out.send(msg.to_string()).map_err(|_| "Chrome closed.".to_string())?;
        match tokio::time::timeout(SEND_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Chrome closed.".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Chrome did not answer {method} in time."))
            }
        }
    }

    pub fn events(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
}
