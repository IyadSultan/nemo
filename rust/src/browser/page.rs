//! What the agent needs from a browser. Two kinds give it:
//! the app's own browser tab (`pane.rs`, WebKit in the Second Brain window), and Chrome over CDP (`chrome.rs`).

use async_trait::async_trait;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Tab {
    pub id: String,
    pub url: String,
    pub title: String,
}

impl Tab {
    /// The short id the model sees: the last four characters.
    pub fn short(&self) -> &str {
        &self.id[self.id.len().saturating_sub(4)..]
    }
}

/// One key press: `key` and `code` as in KeyboardEvent, `text` typed by it (if any),
/// `modifiers` as in CDP (Alt 1, Control 2, Meta 4, Shift 8).
#[derive(Clone, Debug, Default)]
pub struct Key {
    pub key: String,
    pub code: String,
    pub key_code: u32,
    pub text: String,
    pub modifiers: u32,
}

#[async_trait]
pub trait Page: Send + Sync {
    /// Run a JavaScript expression in the page and return its value. It must not return a promise.
    async fn eval(&self, expression: &str) -> Result<Value, String>;
    async fn navigate(&mut self, url: &str) -> Result<(), String>;
    async fn new_tab(&mut self, url: &str) -> Result<(), String>;
    async fn tabs(&self) -> Result<Vec<Tab>, String>;
    /// The id of the tab it works in.
    fn current(&self) -> String;
    async fn switch(&mut self, id: &str) -> Result<(), String>;
    async fn close_tab(&mut self, id: &str) -> Result<(), String>;
    /// A left click at a point in the page (CSS pixels from the viewport's top left).
    async fn click_at(&self, x: f64, y: f64) -> Result<(), String>;
    /// Type into whatever has focus.
    async fn insert_text(&self, text: &str) -> Result<(), String>;
    async fn key(&self, key: &Key) -> Result<(), String>;
    /// Put a file into the file box near element `index`.
    async fn upload(&self, index: usize, path: &str) -> Result<(), String>;
    /// A JPEG of what is on screen.
    async fn screenshot(&self) -> Result<Vec<u8>, String>;

    async fn url(&self) -> String {
        self.eval("location.href").await.ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }

    /// Wait until the page has loaded, then a little more for scripts to draw it.
    async fn settle(&self) {
        let start = Instant::now();
        tokio::time::sleep(Duration::from_millis(300)).await;
        while start.elapsed() < Duration::from_secs(10) {
            if let Ok(v) = self.eval("document.readyState").await {
                if v == "complete" {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
