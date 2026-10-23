//! Start (or find) the agent's own Chrome, and drive one tab of it.
//!
//! The agent's Chrome has its own profile, so logins made there persist and
//! the user's everyday Chrome is never touched. It stays open after a task.

use super::cdp::Cdp;
pub use super::page::Tab;
use super::page::{Key, Page};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct Launch {
    pub port: u16,
    pub profile: PathBuf,
    pub headless: bool,
}

impl Default for Launch {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Launch {
            port: 9333,
            // Not "hey-my-brain-chrome": Hammerspoon closes that one.
            profile: PathBuf::from(home).join("Library/Application Support/brain-browser-agent"),
            headless: false,
        }
    }
}

pub fn chrome_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHROME_BIN") {
        return Some(p.into());
    }
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

async fn ws_url(port: u16) -> Option<String> {
    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    let v: Value = res.json().await.ok()?;
    v["webSocketDebuggerUrl"].as_str().map(str::to_string)
}

/// The DevTools address of the agent's Chrome, starting it if it is not running.
pub async fn ensure(launch: &Launch) -> Result<String, String> {
    if let Some(url) = ws_url(launch.port).await {
        return Ok(url);
    }
    let bin = chrome_bin().ok_or("Google Chrome is not installed.")?;
    let _ = std::fs::create_dir_all(&launch.profile);
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--remote-debugging-port={}", launch.port))
        .arg(format!("--user-data-dir={}", launch.profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if launch.headless {
        cmd.arg("--headless=new");
    }
    cmd.spawn().map_err(|e| format!("Could not start Chrome ({e})."))?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(url) = ws_url(launch.port).await {
            return Ok(url);
        }
    }
    Err("Chrome started but did not open its DevTools port.".into())
}

/// One Chrome, with the tab the agent is working in.
pub struct Browser {
    pub cdp: Arc<Cdp>,
    pub target: String,
    pub session: String,
}

impl Browser {
    pub async fn open(launch: &Launch) -> Result<Browser, String> {
        let cdp = Cdp::connect(&ensure(launch).await?).await?;
        let pages = page_targets(&cdp).await?;
        let target = match pages.first() {
            Some(t) => t.id.clone(),
            None => cdp.send("Target.createTarget", json!({ "url": "about:blank" }), None).await?["targetId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        };
        let mut b = Browser { cdp, target: String::new(), session: String::new() };
        b.attach(&target).await?;
        Ok(b)
    }

    /// Work in this tab from now on.
    pub async fn attach(&mut self, target: &str) -> Result<(), String> {
        let r = self.cdp.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        self.session = r["sessionId"].as_str().ok_or("Chrome did not attach to the tab.")?.to_string();
        self.target = target.to_string();
        let _ = self.cdp.send("Target.activateTarget", json!({ "targetId": target }), None).await;
        self.send("Page.enable", json!({})).await?;
        self.send("Runtime.enable", json!({})).await?;
        // A page's alert() or confirm() would block every later command, so accept it.
        let mut events = self.cdp.events();
        let (cdp, session) = (self.cdp.clone(), self.session.clone());
        tokio::spawn(async move {
            while let Ok(ev) = events.recv().await {
                if ev["method"] == "Page.javascriptDialogOpening" && ev["sessionId"] == session.as_str() {
                    let _ = cdp.send("Page.handleJavaScriptDialog", json!({ "accept": true }), Some(&session)).await;
                }
                if ev["method"] == "Target.detachedFromTarget" && ev["params"]["sessionId"] == session.as_str() {
                    break;
                }
            }
        });
        Ok(())
    }

    pub async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.send(method, params, Some(&self.session)).await
    }

    /// Run JavaScript in the page and return its value.
    pub async fn eval(&self, expression: &str) -> Result<Value, String> {
        let r = self
            .send("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }))
            .await?;
        if let Some(e) = r.get("exceptionDetails") {
            let why = e["exception"]["description"].as_str().or(e["text"].as_str()).unwrap_or("script error");
            return Err(why.lines().next().unwrap_or(why).to_string());
        }
        Ok(r["result"]["value"].clone())
    }

    pub async fn tabs(&self) -> Result<Vec<Tab>, String> {
        page_targets(&self.cdp).await
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        let r = self.send("Page.navigate", json!({ "url": url })).await?;
        if let Some(e) = r["errorText"].as_str() {
            return Err(format!("Could not open {url} ({e})."));
        }
        self.settle().await;
        Ok(())
    }

    pub async fn new_tab(&mut self, url: &str) -> Result<(), String> {
        let r = self.cdp.send("Target.createTarget", json!({ "url": url }), None).await?;
        let id = r["targetId"].as_str().ok_or("Chrome did not open a tab.")?.to_string();
        self.attach(&id).await?;
        self.settle().await;
        Ok(())
    }

    pub async fn screenshot(&self) -> Result<Vec<u8>, String> {
        use base64::Engine;
        let r = self.send("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70 })).await?;
        base64::engine::general_purpose::STANDARD.decode(r["data"].as_str().unwrap_or("")).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Page for Browser {
    async fn eval(&self, expression: &str) -> Result<Value, String> {
        Browser::eval(self, expression).await
    }
    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        Browser::navigate(self, url).await
    }
    async fn new_tab(&mut self, url: &str) -> Result<(), String> {
        Browser::new_tab(self, url).await
    }
    async fn tabs(&self) -> Result<Vec<Tab>, String> {
        page_targets(&self.cdp).await
    }
    fn current(&self) -> String {
        self.target.clone()
    }
    async fn switch(&mut self, id: &str) -> Result<(), String> {
        self.attach(id).await
    }
    async fn close_tab(&mut self, id: &str) -> Result<(), String> {
        let tabs = page_targets(&self.cdp).await?;
        self.cdp.send("Target.closeTarget", json!({ "targetId": id }), None).await?;
        if id == self.target {
            match tabs.iter().find(|t| t.id != id) {
                Some(other) => self.attach(&other.id.clone()).await?,
                None => Browser::new_tab(self, "about:blank").await?,
            }
        }
        Ok(())
    }
    async fn click_at(&self, x: f64, y: f64) -> Result<(), String> {
        self.send("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y })).await?;
        for kind in ["mousePressed", "mouseReleased"] {
            self.send("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
        }
        Ok(())
    }
    async fn insert_text(&self, text: &str) -> Result<(), String> {
        self.send("Input.insertText", json!({ "text": text })).await.map(|_| ())
    }
    async fn key(&self, k: &Key) -> Result<(), String> {
        let mut down = json!({ "type": "keyDown", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.key_code, "modifiers": k.modifiers });
        if !k.text.is_empty() {
            down["text"] = json!(k.text);
        }
        self.send("Input.dispatchKeyEvent", down).await?;
        self.send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.key_code, "modifiers": k.modifiers }))
            .await
            .map(|_| ())
    }
    async fn upload(&self, index: usize, path: &str) -> Result<(), String> {
        // The element itself, or the file input inside or beside it.
        let r = self
            .send(
                "Runtime.evaluate",
                json!({ "expression": format!(
                    "(() => {{ const el = (window.__brainEls || [])[{index}];
                      if (!el) return null;
                      if (el.type === 'file') return el;
                      return el.querySelector?.('input[type=file]') || el.closest('form,div,label')?.querySelector('input[type=file]')
                          || document.querySelector('input[type=file]'); }})()"
                ) }),
            )
            .await?;
        let object = r["result"]["objectId"].as_str().ok_or(format!("No file box near [{index}]."))?;
        self.send("DOM.setFileInputFiles", json!({ "files": [path], "objectId": object })).await.map(|_| ())
    }
    async fn screenshot(&self) -> Result<Vec<u8>, String> {
        Browser::screenshot(self).await
    }
}

async fn page_targets(cdp: &Cdp) -> Result<Vec<Tab>, String> {
    let r = cdp.send("Target.getTargets", json!({}), None).await?;
    Ok(r["targetInfos"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|t| t["type"] == "page" && !t["url"].as_str().unwrap_or("").starts_with("devtools://"))
        .map(|t| Tab {
            id: t["targetId"].as_str().unwrap_or_default().to_string(),
            url: t["url"].as_str().unwrap_or_default().to_string(),
            title: t["title"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}
