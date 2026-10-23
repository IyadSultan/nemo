//! What the agent can do in the page, and the page state it sees.
//! Names and fields follow browser-use (tools/views.py), so its prompt habits carry over.

use super::page::{Key, Page};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

const DOM_JS: &str = include_str!("dom.js");

/// What the model sees of the page each step.
#[derive(Clone, Debug, Default)]
pub struct PageState {
    pub url: String,
    pub title: String,
    /// `[n]<tag ...>` lines and visible text.
    pub text: String,
    pub count: usize,
    pub hash: String,
    pub above: f64,
    pub below: f64,
}

pub async fn page_state(b: &dyn Page) -> Result<PageState, String> {
    let v = b.eval(DOM_JS).await?;
    Ok(PageState {
        url: v["url"].as_str().unwrap_or_default().into(),
        title: v["title"].as_str().unwrap_or_default().into(),
        text: v["text"].as_str().unwrap_or_default().into(),
        count: v["count"].as_u64().unwrap_or(0) as usize,
        hash: v["hash"].as_str().unwrap_or_default().into(),
        above: v["above"].as_f64().unwrap_or(0.0),
        below: v["below"].as_f64().unwrap_or(0.0),
    })
}

fn yes() -> bool {
    true
}
fn one() -> f64 {
    1.0
}
fn three() -> f64 {
    3.0
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Done {
        text: String,
        #[serde(default = "yes")]
        success: bool,
    },
    Search {
        query: String,
    },
    Navigate {
        url: String,
        #[serde(default)]
        new_tab: bool,
    },
    GoBack {},
    Wait {
        #[serde(default = "three")]
        seconds: f64,
    },
    Click {
        index: usize,
    },
    Input {
        index: usize,
        text: String,
        #[serde(default = "yes")]
        clear: bool,
    },
    SelectDropdown {
        index: usize,
        text: String,
    },
    DropdownOptions {
        index: usize,
    },
    Scroll {
        #[serde(default = "yes")]
        down: bool,
        #[serde(default = "one")]
        pages: f64,
        #[serde(default)]
        index: Option<usize>,
    },
    SendKeys {
        keys: String,
    },
    Switch {
        tab_id: String,
    },
    Close {
        tab_id: String,
    },
    UploadFile {
        index: usize,
        path: String,
    },
    FindText {
        text: String,
    },
    ReadPage {
        #[serde(default)]
        start_from_char: usize,
    },
}

impl Action {
    /// A short line for the page card and the agent's history. Typed text is shown as given,
    /// so a `<secret>name</secret>` stays a placeholder.
    pub fn describe(&self) -> String {
        match self {
            Action::Done { text, .. } => format!("done: {}", crate::js::slice16(text, 0, 120)),
            Action::Search { query } => format!("search \"{query}\""),
            Action::Navigate { url, new_tab } => format!("open {url}{}", if *new_tab { " in a new tab" } else { "" }),
            Action::GoBack {} => "go back".into(),
            Action::Wait { seconds } => format!("wait {seconds}s"),
            Action::Click { index } => format!("click [{index}]"),
            Action::Input { index, text, .. } => format!("type \"{text}\" into [{index}]"),
            Action::SelectDropdown { index, text } => format!("choose \"{text}\" in [{index}]"),
            Action::DropdownOptions { index } => format!("list options of [{index}]"),
            Action::Scroll { down, pages, .. } => format!("scroll {} {pages} page(s)", if *down { "down" } else { "up" }),
            Action::SendKeys { keys } => format!("press {keys}"),
            Action::Switch { tab_id } => format!("switch to tab {tab_id}"),
            Action::Close { tab_id } => format!("close tab {tab_id}"),
            Action::UploadFile { index, path } => format!("upload {path} to [{index}]"),
            Action::FindText { text } => format!("find \"{text}\""),
            Action::ReadPage { start_from_char } => format!("read the page from char {start_from_char}"),
        }
    }

    /// Actions after which the page is probably different, so the rest of the step's actions are dropped.
    pub fn changes_page(&self) -> bool {
        matches!(self, Action::Search { .. } | Action::Navigate { .. } | Action::GoBack {} | Action::Switch { .. } | Action::Close { .. })
    }
}

/// What one action did.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    /// A line for the agent's history.
    pub said: String,
    /// Page text the model asked for, shown in the next step only.
    pub read: Option<String>,
    pub error: Option<String>,
}

fn ok(said: impl Into<String>) -> Result<Outcome, String> {
    Ok(Outcome { said: said.into(), ..Default::default() })
}

/// The element's centre after scrolling it into view, or an error the model can act on.
async fn element_point(b: &dyn Page, index: usize) -> Result<(f64, f64, String), String> {
    let v = b
        .eval(&format!(
            "(() => {{ const el = (window.__brainEls || [])[{index}];
              if (!el || !el.isConnected) return null;
              el.scrollIntoView({{ block: 'center', inline: 'center' }});
              const r = el.getBoundingClientRect();
              return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() }}; }})()"
        ))
        .await?;
    if v.is_null() {
        return Err(format!("Element [{index}] is not on the page any more. Use an index from the current page."));
    }
    Ok((v["x"].as_f64().unwrap_or(0.0), v["y"].as_f64().unwrap_or(0.0), v["tag"].as_str().unwrap_or("").into()))
}

async fn dropdown_options(b: &dyn Page, index: usize) -> Result<Outcome, String> {
    let v = b
        .eval(&format!(
            "(() => {{ const el = (window.__brainEls || [])[{index}];
              if (!el || !el.options) return null;
              return [...el.options].map((o, i) => i + ': ' + o.text.trim() + (o.value && o.value !== o.text.trim() ? ' (value=' + o.value + ')' : '')); }})()"
        ))
        .await?;
    let Some(list) = v.as_array() else {
        return Err(format!("[{index}] is not a dropdown."));
    };
    let lines: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
    Ok(Outcome {
        said: format!("[{index}] has {} options", lines.len()),
        read: Some(format!("Options of [{index}]:\n{}\nUse select_dropdown with the exact text.", lines.join("\n"))),
        error: None,
    })
}

/// Key name to (key, code, keyCode, text).
fn key_info(name: &str) -> Option<(&'static str, &'static str, u32, &'static str)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => ("Enter", "Enter", 13, "\r"),
        "tab" => ("Tab", "Tab", 9, ""),
        "escape" | "esc" => ("Escape", "Escape", 27, ""),
        "backspace" => ("Backspace", "Backspace", 8, ""),
        "delete" => ("Delete", "Delete", 46, ""),
        "space" => (" ", "Space", 32, " "),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, ""),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, ""),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, ""),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, ""),
        "pagedown" => ("PageDown", "PageDown", 34, ""),
        "pageup" => ("PageUp", "PageUp", 33, ""),
        "home" => ("Home", "Home", 36, ""),
        "end" => ("End", "End", 35, ""),
        _ => return None,
    })
}

/// "Enter", "Control+a", "Tab Tab Enter".
async fn send_keys(b: &dyn Page, keys: &str) -> Result<(), String> {
    for combo in keys.split_whitespace() {
        let parts: Vec<&str> = combo.split('+').collect();
        let (mods, key) = parts.split_at(parts.len() - 1);
        let mut bits = 0;
        for m in mods {
            bits |= match m.to_ascii_lowercase().as_str() {
                "alt" | "option" => 1,
                "control" | "ctrl" => 2,
                "meta" | "cmd" | "command" => 4,
                "shift" => 8,
                other => return Err(format!("Unknown key {other}.")),
            };
        }
        let key = key[0];
        let (k, code, kc, text) = match key_info(key) {
            Some(i) => (i.0.to_string(), i.1.to_string(), i.2, i.3.to_string()),
            None if key.chars().count() == 1 => {
                let c = key.chars().next().unwrap();
                let up = c.to_ascii_uppercase();
                let code = if c.is_ascii_alphabetic() { format!("Key{up}") } else if c.is_ascii_digit() { format!("Digit{c}") } else { String::new() };
                // With Control or Meta held, a letter is a shortcut, not typing.
                let text = if bits & 6 == 0 { c.to_string() } else { String::new() };
                (c.to_string(), code, up as u32, text)
            }
            None => return Err(format!("Unknown key {key}.")),
        };
        b.key(&Key { key: k, code, key_code: kc, text, modifiers: bits }).await?;
    }
    Ok(())
}

/// Run one action. `typed` is the text with secrets filled in (Input only); `files` are the paths upload_file may use.
pub async fn run(b: &mut dyn Page, action: &Action, typed: Option<&str>, files: &[PathBuf]) -> Result<Outcome, String> {
    match action {
        Action::Done { text, .. } => ok(text.clone()),
        Action::Search { query } => {
            let url = format!("https://duckduckgo.com/?q={}", url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>());
            b.navigate(&url).await?;
            ok(format!("Searched for \"{query}\""))
        }
        Action::Navigate { url, new_tab } => {
            let url = if url.contains("://") || url.starts_with("about:") { url.clone() } else { format!("https://{url}") };
            if *new_tab {
                b.new_tab(&url).await?;
            } else {
                b.navigate(&url).await?;
            }
            ok(format!("Opened {url}"))
        }
        Action::GoBack {} => {
            b.eval("history.back()").await?;
            b.settle().await;
            ok("Went back")
        }
        Action::Wait { seconds } => {
            tokio::time::sleep(Duration::from_secs_f64(seconds.clamp(0.0, 30.0))).await;
            ok(format!("Waited {seconds}s"))
        }
        Action::Click { index } => {
            let (x, y, tag) = element_point(b, *index).await?;
            if tag == "select" {
                return dropdown_options(b, *index).await;
            }
            let before: Vec<String> = b.tabs().await?.into_iter().map(|t| t.id).collect();
            b.click_at(x, y).await?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            // A link that opens a new tab: follow it there, as a person would.
            if let Some(t) = b.tabs().await?.into_iter().find(|t| !before.contains(&t.id)) {
                b.switch(&t.id).await?;
                b.settle().await;
                return ok(format!("Clicked [{index}]; it opened a new tab, now working there"));
            }
            b.settle().await;
            ok(format!("Clicked [{index}]"))
        }
        Action::Input { index, text, clear } => {
            let value = typed.unwrap_or(text);
            let found = b
                .eval(&format!(
                    "(() => {{ const el = (window.__brainEls || [])[{index}];
                      if (!el || !el.isConnected) return false;
                      el.scrollIntoView({{ block: 'center' }}); el.focus();
                      if ({clear}) {{
                        if ('value' in el) {{ const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                          Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', {{ bubbles: true }})); }}
                        else if (el.isContentEditable) {{ document.execCommand('selectAll'); document.execCommand('delete'); }}
                      }}
                      return true; }})()"
                ))
                .await?;
            if found != true {
                return Err(format!("Element [{index}] is not on the page any more. Use an index from the current page."));
            }
            b.insert_text(value).await?;
            b.eval(&format!(
                "(() => {{ const el = window.__brainEls[{index}]; el.dispatchEvent(new Event('change', {{ bubbles: true }})); }})()"
            ))
            .await?;
            ok(format!("Typed \"{text}\" into [{index}]"))
        }
        Action::SelectDropdown { index, text } => {
            let want = serde_json::to_string(&text.trim().to_lowercase()).unwrap();
            let v = b
                .eval(&format!(
                    "(() => {{ const el = (window.__brainEls || [])[{index}];
                      if (!el || !el.options) return 'none';
                      const want = {want};
                      const o = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
                             || [...el.options].find(o => o.text.trim().toLowerCase().includes(want));
                      if (!o) return 'missing';
                      el.value = o.value;
                      el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                      el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                      return o.text.trim(); }})()"
                ))
                .await?;
            match v.as_str() {
                Some("none") => Err(format!("[{index}] is not a dropdown. Click it, then choose from what opens.")),
                Some("missing") => Err(format!("\"{text}\" is not an option of [{index}]. Use dropdown_options to see them.")),
                Some(chosen) => ok(format!("Chose \"{chosen}\" in [{index}]")),
                None => Err("The dropdown did not answer.".into()),
            }
        }
        Action::DropdownOptions { index } => dropdown_options(b, *index).await,
        Action::Scroll { down, pages, index } => {
            let dy = if *down { 1.0 } else { -1.0 } * pages;
            let target = match index {
                Some(i) => format!("(window.__brainEls || [])[{i}]"),
                None => "null".into(),
            };
            b.eval(&format!(
                "(() => {{ const el = {target}; const by = innerHeight * 0.85 * {dy};
                  if (el) el.scrollBy(0, by); else window.scrollBy(0, by); }})()"
            ))
            .await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            ok(action.describe())
        }
        Action::SendKeys { keys } => {
            send_keys(b, keys).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            if keys.to_ascii_lowercase().contains("enter") {
                b.settle().await;
            }
            ok(format!("Pressed {keys}"))
        }
        Action::Switch { tab_id } => {
            let tab = b.tabs().await?.into_iter().find(|t| t.short() == tab_id || t.id == *tab_id).ok_or(format!("No tab {tab_id}."))?;
            b.switch(&tab.id).await?;
            ok(format!("Switched to {}", tab.url))
        }
        Action::Close { tab_id } => {
            let tab = b.tabs().await?.into_iter().find(|t| t.short() == tab_id || t.id == *tab_id).ok_or(format!("No tab {tab_id}."))?;
            b.close_tab(&tab.id).await?;
            ok(format!("Closed tab {tab_id}"))
        }
        Action::UploadFile { index, path } => {
            let p = PathBuf::from(path);
            if !files.iter().any(|f| *f == p) {
                return Err(format!("{path} is not one of the files you were given."));
            }
            b.upload(*index, path).await?;
            ok(format!("Uploaded {path}"))
        }
        Action::FindText { text } => {
            let want = serde_json::to_string(&text.to_lowercase()).unwrap();
            let found = b
                .eval(&format!(
                    "(() => {{ const want = {want};
                      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                      while (w.nextNode()) {{
                        if (w.currentNode.textContent.toLowerCase().includes(want)) {{
                          w.currentNode.parentElement.scrollIntoView({{ block: 'center' }}); return true; }} }}
                      return false; }})()"
                ))
                .await?;
            if found == true {
                ok(format!("Scrolled to \"{text}\""))
            } else {
                Err(format!("\"{text}\" is not on this page."))
            }
        }
        Action::ReadPage { start_from_char } => {
            const CHUNK: usize = 12000;
            let all = b.eval("document.body ? document.body.innerText : ''").await?;
            let all: Vec<char> = all.as_str().unwrap_or("").chars().collect();
            let from = (*start_from_char).min(all.len());
            let to = (from + CHUNK).min(all.len());
            let piece: String = all[from..to].iter().collect();
            let more = if to < all.len() { format!("\n[{} more characters: read_page with start_from_char={to}]", all.len() - to) } else { String::new() };
            Ok(Outcome {
                said: format!("Read characters {from}-{to} of {}", all.len()),
                read: Some(format!("{piece}{more}")),
                error: None,
            })
        }
    }
}
