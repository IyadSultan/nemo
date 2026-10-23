//! A browser agent, rebuilt in Rust after browser-use (https://github.com/browser-use/browser-use).
//!
//! The user gives an order ("fill in the form at …", "order … from …") by voice or typing.
//! 1. `plan` makes a short step plan with one Claude call; the user says yes once.
//! 2. `run` drives the agent's own Chrome over CDP, one step at a time, until done.
//!    Each step the page is read as numbered elements (`[12]<button>Send</button>`),
//!    Claude picks up to five actions, and they run in order.
//! Events go out as they happen: `thinking`, `step`, `action`, `error`, `done`.
//! Only one task runs at a time; `stop` and `say` steer it.
//! It works in the app's own Browser tab when the Second Brain window is open (`pane.rs`),
//! and in its own Chrome window otherwise (`chrome.rs`).

pub mod actions;
pub mod agent;
pub mod cdp;
pub mod chrome;
pub mod page;
pub mod pane;

use agent::{ClaudeSteps, Control, Events, Secrets, StepModel, Task};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Every step runs on this model, for speed.
pub const STEP_MODEL: &str = crate::team::HELPER_MODEL;

const PLAN_SYSTEM: &str = "You plan tasks for a browser agent that works a real Chrome window: it opens sites, searches, clicks, types into forms, picks options and reads pages. \
Write the plan the user will approve before it starts. Answer with one JSON object and nothing else: \
{\"plan\": [\"3 to 10 short steps, each one thing done in the browser\"], \"questions\": [\"only facts the agent cannot find and cannot guess, needed to finish (for example a date or size the user did not give)\"], \"spoken\": \"one or two plain sentences saying what you will do, for reading aloud\"}. \
Keep questions empty when the task is clear enough. Never ask for passwords or card numbers. \
Use the site the user named, or the page the browser is already showing; plan other sites only when the task cannot be done there.";

/// The plan the user approves: steps, anything the agent needs to know first, and a line to say.
pub async fn plan(model: &dyn StepModel, task: &str, secrets: &Secrets) -> Result<Value, String> {
    let names: Vec<&str> = secrets.0.iter().map(|(n, _)| n.as_str()).collect();
    let known = if names.is_empty() { String::new() } else { format!("\nThe agent already knows the user's: {}.", names.join(", ")) };
    let reply = model.ask(PLAN_SYSTEM, &format!("Task: {task}{known}\nToday is {}.", chrono::Local::now().format("%A %Y-%m-%d")), None).await?;
    let start = reply.find('{').ok_or("The plan had no JSON.")?;
    let end = reply.rfind('}').ok_or("The plan had no JSON.")?;
    let v: Value = serde_json::from_str(&reply[start..=end.max(start)]).map_err(|e| format!("The plan was not valid JSON ({e})."))?;
    let list = |k: &str| -> Vec<String> {
        v[k].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    let steps = list("plan");
    if steps.is_empty() {
        return Err("The plan was empty.".into());
    }
    Ok(json!({ "plan": steps, "questions": list("questions"), "spoken": v["spoken"].as_str().unwrap_or("") }))
}

/// The task running now, so stop and say can reach it.
static RUNNING: Mutex<Option<Arc<Control>>> = Mutex::new(None);

pub fn stop() -> bool {
    match RUNNING.lock().unwrap().as_ref() {
        Some(c) => {
            c.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            true
        }
        None => false,
    }
}

pub fn say(note: &str) -> bool {
    match RUNNING.lock().unwrap().as_ref() {
        Some(c) => {
            c.notes.lock().unwrap().push(note.to_string());
            true
        }
        None => false,
    }
}

pub fn busy() -> bool {
    RUNNING.lock().unwrap().is_some()
}

/// Where screenshots and the run log go.
pub fn work_dir(repo: &std::path::Path) -> PathBuf {
    repo.join("second-brain").join("tmp").join("browser")
}

/// Run one task in the agent's Chrome, sending events to `tx`. Returns false if one is already running.
pub fn start(task: Task, repo: PathBuf, tx: Events) -> bool {
    let control = Arc::new(Control::default());
    {
        let mut running = RUNNING.lock().unwrap();
        if running.is_some() {
            return false;
        }
        *running = Some(control.clone());
    }
    tokio::spawn(async move {
        let dir = work_dir(&repo);
        let _ = std::fs::create_dir_all(&dir);
        let secrets = Secrets::from_env();
        let model = ClaudeSteps { model: STEP_MODEL.into(), tokens: Arc::default() };
        let finish = if let Some(mut p) = pane::PanePage::open().await {
            let _ = tx.send(json!({ "type": "where", "in": "app" }));
            Some(agent::run(task.clone(), &mut p, &model, &secrets, &control, Some(dir.clone()), &tx).await)
        } else {
            match chrome::Browser::open(&chrome::Launch::default()).await {
                Ok(mut b) => {
                    let _ = tx.send(json!({ "type": "where", "in": "chrome" }));
                    Some(agent::run(task.clone(), &mut b, &model, &secrets, &control, Some(dir.clone()), &tx).await)
                }
                Err(e) => {
                    let _ = tx.send(json!({ "type": "done", "text": format!("I could not open the browser. {e}"), "success": false, "steps": 0 }));
                    None
                }
            }
        };
        if let Some(f) = finish {
            let t = *model.tokens.lock().unwrap();
            let _ = tx.send(json!({ "type": "tokens", "input": t.input, "cached": t.cached, "output": t.output }));
            // A line per run, with the secrets' values never written.
            let line = json!({
                "at": chrono::Local::now().to_rfc3339(), "task": secrets.hide(&task.task),
                "steps": f.steps, "success": f.success, "result": f.text,
            });
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("runs.jsonl")) {
                let _ = writeln!(file, "{line}");
            }
        }
        *RUNNING.lock().unwrap() = None;
    });
    true
}

/// The default planner and step model, for the plan route.
pub fn claude() -> ClaudeSteps {
    ClaudeSteps { model: STEP_MODEL.into(), tokens: Arc::default() }
}
