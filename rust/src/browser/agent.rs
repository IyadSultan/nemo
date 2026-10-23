//! The step loop, after browser-use's Agent.step(): look at the page, ask the model
//! for the next actions, run them, remember what happened, until `done`.

use super::actions::{self, Action, PageState};
use super::page::Page;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const SYSTEM: &str = include_str!("prompt.md");
pub const MAX_STEPS: usize = 25;
const MAX_FAILURES: usize = 5;
const MAX_ACTIONS: usize = 5;
/// History lines kept in the prompt: the first step and the most recent ones.
const KEEP_HISTORY: usize = 12;
const MAX_PAGE_CHARS: usize = 40000;

/// Anything that can choose the next actions. Claude in the app; a script in tests.
#[async_trait]
pub trait StepModel: Send + Sync {
    /// `screenshot`: a JPEG the model should look at, if any.
    async fn ask(&self, system: &str, prompt: &str, screenshot: Option<&std::path::Path>) -> Result<String, String>;
}

/// Values the model must not see. It types `<secret>name</secret>`; the value goes into the page.
#[derive(Clone, Debug, Default)]
pub struct Secrets(pub Vec<(String, String)>);

impl Secrets {
    /// `BROWSER_SECRET_EMAIL=...` in .env becomes the secret `email`.
    pub fn from_env() -> Secrets {
        let mut v: Vec<(String, String)> = std::env::vars()
            .filter_map(|(k, val)| k.strip_prefix("BROWSER_SECRET_").map(|n| (n.to_lowercase(), val)))
            .filter(|(_, val)| !val.is_empty())
            .collect();
        v.sort();
        Secrets(v)
    }

    pub fn fill(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (name, val) in &self.0 {
            out = out.replace(&format!("<secret>{name}</secret>"), val);
        }
        out
    }

    /// Put placeholders back wherever a value shows (typed into a field, echoed on a page).
    pub fn hide(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (name, val) in &self.0 {
            if val.chars().count() >= 3 {
                out = out.replace(val.as_str(), &format!("<secret>{name}</secret>"));
            }
        }
        out
    }
}

/// One task for the agent.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Task {
    pub task: String,
    #[serde(default)]
    pub plan: Vec<String>,
    #[serde(default)]
    pub max_steps: Option<usize>,
    /// Files it may upload.
    #[serde(default)]
    pub files: Vec<PathBuf>,
    #[serde(default)]
    pub use_vision: bool,
}

/// Steering from outside while it runs: "stop", or a note the user added.
#[derive(Default)]
pub struct Control {
    pub stop: AtomicBool,
    pub notes: Mutex<Vec<String>>,
}

/// The model's answer, as in browser-use's AgentOutput.
#[derive(Debug, Default, Deserialize)]
pub struct AgentOutput {
    #[serde(default)]
    pub thinking: String,
    #[serde(default)]
    pub evaluation_previous_goal: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub next_goal: String,
    #[serde(default)]
    pub current_plan_item: Option<usize>,
    #[serde(default)]
    pub plan_update: Option<Vec<String>>,
    #[serde(default)]
    pub action: Vec<Value>,
}

/// The first JSON object in a reply, with or without a code fence around it.
pub fn parse_output(reply: &str) -> Result<AgentOutput, String> {
    let start = reply.find('{').ok_or("The reply had no JSON.")?;
    let end = reply.rfind('}').ok_or("The reply had no JSON.")?;
    if end < start {
        return Err("The reply had no JSON.".into());
    }
    serde_json::from_str(&reply[start..=end]).map_err(|e| format!("The reply was not valid JSON ({e})."))
}

pub type Events = tokio::sync::mpsc::UnboundedSender<Value>;

fn plan_text(plan: &[String], current: usize) -> String {
    plan.iter()
        .enumerate()
        .map(|(i, item)| {
            let mark = if i < current { "[x]" } else if i == current { "[>]" } else { "[ ]" };
            format!("{mark} {}. {item}", i + 1)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(clippy::too_many_arguments)]
fn step_prompt(task: &Task, history: &[String], plan: &[String], current: usize, notes: &[String], secrets: &Secrets, tabs: &str, page: &PageState, read: &str, step: usize, max: usize, nudge: &str) -> String {
    let mut h: Vec<String> = Vec::new();
    if history.len() > KEEP_HISTORY {
        h.push(history[0].clone());
        h.push(format!("[{} earlier steps left out]", history.len() - KEEP_HISTORY));
        h.extend(history[history.len() - (KEEP_HISTORY - 1)..].iter().cloned());
    } else {
        h.extend(history.iter().cloned());
    }
    let mut state = format!("<plan>\n{}\n</plan>\n", plan_text(plan, current));
    if !notes.is_empty() {
        state += &format!("<user_notes>\nThe user added this while you worked; follow it:\n{}\n</user_notes>\n", notes.join("\n"));
    }
    if !secrets.0.is_empty() {
        let names: Vec<String> = secrets.0.iter().map(|(n, _)| format!("<secret>{n}</secret>")).collect();
        state += &format!("<sensitive_data>\nYou may type these placeholders: {}\n</sensitive_data>\n", names.join(", "));
    }
    if !task.files.is_empty() {
        let files: Vec<String> = task.files.iter().map(|f| f.display().to_string()).collect();
        state += &format!("<available_file_paths>\n{}\n</available_file_paths>\n", files.join("\n"));
    }
    let text = if page.text.chars().count() > MAX_PAGE_CHARS {
        format!("{}\n[page cut off; scroll for more]", crate::js::slice16(&page.text, 0, MAX_PAGE_CHARS))
    } else {
        page.text.clone()
    };
    let top = if page.above > 0.0 { format!("... {} pages above ...\n", page.above) } else { "[Start of page]\n".into() };
    let bottom = if page.below > 0.0 { format!("\n... {} pages below ...", page.below) } else { "\n[End of page]".into() };
    let read = if read.is_empty() { String::new() } else { format!("<read_state>\n{read}\n</read_state>\n") };
    let nudge = if nudge.is_empty() { String::new() } else { format!("\n{nudge}") };
    format!(
        "<user_request>\n{}\n</user_request>\n<agent_history>\n{}\n</agent_history>\n<agent_state>\n{state}</agent_state>\n<browser_state>\nTabs:\n{tabs}\nCurrent: {} — {}\n{} interactive elements:\n{top}{text}{bottom}\n</browser_state>\n{read}<step_info>\nStep {step} of {max}. Today is {}.{nudge}\n</step_info>",
        task.task,
        if h.is_empty() { "No steps yet.".into() } else { h.join("\n") },
        page.title,
        page.url,
        page.count,
        chrono::Local::now().format("%A %Y-%m-%d %H:%M"),
    )
}

/// How the run ended.
#[derive(Debug, Clone, PartialEq)]
pub struct Finish {
    pub text: String,
    pub success: bool,
    pub steps: usize,
}

fn emit(tx: &Events, v: Value) {
    let _ = tx.send(v);
}

/// Run the task to the end. Events: `step`, `action`, `error`, `done`.
pub async fn run(task: Task, b: &mut dyn Page, model: &dyn StepModel, secrets: &Secrets, control: &Control, shots: Option<PathBuf>, tx: &Events) -> Finish {
    let max = task.max_steps.unwrap_or(MAX_STEPS).clamp(1, 100);
    let mut plan = task.plan.clone();
    let mut current = 0usize;
    let mut history: Vec<String> = Vec::new();
    let mut read = String::new();
    let mut failures = 0usize;
    let mut vision = task.use_vision;
    let mut seen: Vec<String> = Vec::new();

    for step in 1..=max {
        if control.stop.load(Ordering::Relaxed) {
            return finish(tx, "Stopped, as you asked.".into(), false, step - 1);
        }
        let page = match actions::page_state(b).await {
            Ok(p) => p,
            Err(e) => {
                // A page mid-navigation cannot be read; look again next step.
                emit(tx, json!({ "type": "error", "message": e }));
                b.settle().await;
                actions::page_state(b).await.unwrap_or_default()
            }
        };
        let tabs = b
            .tabs()
            .await
            .unwrap_or_default()
            .iter()
            .map(|t| format!("[{}] {} — {}{}", t.short(), crate::js::slice16(&t.title, 0, 30), t.url, if t.id == b.current() { " (current)" } else { "" }))
            .collect::<Vec<_>>()
            .join("\n");

        // Guards from browser-use: too many failures or the last step allow only done; loops get a nudge.
        let only_done = failures >= MAX_FAILURES || step == max;
        let print = format!("{}|{}", page.url, page.hash);
        let repeats = seen.iter().rev().take(6).filter(|p| **p == print).count();
        seen.push(print);
        let mut nudge = String::new();
        if only_done {
            nudge = "This is your last chance: use only the done action now, with what you achieved and what is left.".into();
        } else if repeats >= 2 {
            nudge = "The page has not changed for several steps. Your approach is not working; try something different.".into();
        } else if step * 4 >= max * 3 {
            nudge = "Most of your steps are used. Finish the most important part and call done soon.".into();
        }
        let notes = control.notes.lock().unwrap().clone();
        let prompt = secrets.hide(&step_prompt(&task, &history, &plan, current, &notes, secrets, &tabs, &page, &read, step, max, &nudge));
        read.clear();

        let shot = match (&shots, vision) {
            (Some(dir), true) => match b.screenshot().await {
                Ok(bytes) => {
                    let path = dir.join(format!("step-{step}.jpg"));
                    std::fs::write(&path, bytes).ok().map(|_| path)
                }
                Err(_) => None,
            },
            _ => None,
        };
        let prompt = match &shot {
            Some(p) => format!("Screenshot of the page now: {} (Read it first).\n\n{prompt}", p.display()),
            None => prompt,
        };

        emit(tx, json!({ "type": "thinking", "step": step, "max": max }));
        let mut out = None;
        let mut why = String::new();
        for attempt in 0..2 {
            let ask = if attempt == 0 { prompt.clone() } else { format!("{prompt}\n\nYour last answer could not be read ({why}). Answer with only the JSON object.") };
            match model.ask(SYSTEM, &ask, shot.as_deref()).await {
                Ok(reply) => match parse_output(&reply) {
                    Ok(o) if !o.action.is_empty() => {
                        out = Some(o);
                        break;
                    }
                    Ok(_) => why = "no actions".into(),
                    Err(e) => why = e,
                },
                Err(e) => {
                    why = e;
                    break;
                }
            }
        }
        let Some(out) = out else {
            failures += 1;
            emit(tx, json!({ "type": "error", "message": format!("The model's step failed: {why}") }));
            history.push(format!("<step {step}> The model's answer failed ({why})."));
            if failures >= MAX_FAILURES + 1 {
                return finish(tx, format!("I had to stop: the model kept failing ({why})."), false, step);
            }
            continue;
        };

        if let Some(p) = out.plan_update.clone().filter(|p| !p.is_empty()) {
            plan = p;
            current = 0;
        }
        if let Some(c) = out.current_plan_item {
            current = c.min(plan.len());
        }
        emit(tx, json!({
            "type": "step", "step": step, "max": max, "goal": secrets.hide(&out.next_goal),
            "evaluation": secrets.hide(&out.evaluation_previous_goal), "plan": plan, "current": current,
        }));

        let mut results: Vec<String> = Vec::new();
        let mut errors = 0usize;
        let mut tried = 0usize;
        let start_url = b.url().await;
        for raw in out.action.iter().take(MAX_ACTIONS) {
            let action: Action = match serde_json::from_value(raw.clone()) {
                Ok(a) => a,
                Err(e) => {
                    tried += 1;
                    errors += 1;
                    results.push(format!("Unknown action {raw} ({e})."));
                    continue;
                }
            };
            if only_done && !matches!(action, Action::Done { .. }) {
                continue;
            }
            if let Action::Done { text, success } = &action {
                // The user hears their own details; the run log keeps the placeholders.
                let text = secrets.hide(text);
                emit(tx, json!({ "type": "done", "text": secrets.fill(&text), "success": success, "steps": step }));
                return Finish { text, success: *success, steps: step };
            }
            tried += 1;
            let typed = match &action {
                Action::Input { text, .. } => Some(secrets.fill(text)),
                _ => None,
            };
            emit(tx, json!({ "type": "action", "step": step, "text": action.describe() }));
            match actions::run(b, &action, typed.as_deref(), &task.files).await {
                Ok(o) => {
                    results.push(secrets.hide(&o.said));
                    if let Some(r) = o.read {
                        read = secrets.hide(&r);
                    }
                }
                Err(e) => {
                    errors += 1;
                    let e = secrets.hide(&e);
                    emit(tx, json!({ "type": "error", "message": e }));
                    results.push(format!("Error: {e}"));
                    break;
                }
            }
            // The rest of the step was planned for a page that is gone.
            if action.changes_page() || b.url().await != start_url {
                break;
            }
        }
        if only_done {
            let text = if out.memory.is_empty() { "I ran out of steps before finishing.".to_string() } else { format!("I could not finish. {}", secrets.hide(&out.memory)) };
            return finish(tx, text, false, step);
        }
        if tried > 0 && errors == tried {
            failures += 1;
        } else {
            failures = 0;
        }
        // Two failures in a row: look at the page as well as reading it.
        if failures >= 2 && shots.is_some() {
            vision = true;
        }
        history.push(secrets.hide(&format!(
            "<step {step}>\nEvaluation: {}\nMemory: {}\nNext goal: {}\nResults: {}",
            out.evaluation_previous_goal,
            out.memory,
            out.next_goal,
            results.join(" | ")
        )));
    }
    finish(tx, "I ran out of steps before finishing.".into(), false, max)
}

fn finish(tx: &Events, text: String, success: bool, steps: usize) -> Finish {
    emit(tx, json!({ "type": "done", "text": text, "success": success, "steps": steps }));
    Finish { text, success, steps }
}

/// The model that runs each step: Claude Sonnet through Claude Code, on the subscription.
pub struct ClaudeSteps {
    pub model: String,
    pub tokens: Arc<Mutex<crate::team::Tokens>>,
}

#[async_trait]
impl StepModel for ClaudeSteps {
    async fn ask(&self, system: &str, prompt: &str, screenshot: Option<&std::path::Path>) -> Result<String, String> {
        // With a screenshot it may Read that one folder; otherwise no tools at all.
        let dirs: Vec<PathBuf> = screenshot.and_then(|p| p.parent()).map(|d| vec![d.to_path_buf()]).unwrap_or_default();
        let cli = crate::team::ClaudeCli {
            bin: crate::team::claude_bin(),
            model: self.model.clone(),
            dirs,
            effort: None,
            timeout: std::time::Duration::from_secs(120),
            tokens: self.tokens.clone(),
            on_doing: None,
            on_log: None,
            workspace: None,
            zotero: false,
        };
        cli.ask(system, prompt, |_| {}).await.map_err(|e| e.to_string())
    }
}
