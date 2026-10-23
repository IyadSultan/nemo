//! The browser agent against a real headless Chrome and a local page, with a
//! scripted model in place of Claude. Skipped when Chrome is not installed.

use async_trait::async_trait;
use nemo_realtime_voice::browser::agent::{self, Control, Secrets, StepModel, Task};
use nemo_realtime_voice::browser::{actions, chrome, pane};
use std::sync::Mutex;

fn fixture() -> String {
    format!("file://{}/tests/fixtures/browser/form.html", env!("CARGO_MANIFEST_DIR"))
}

async fn headless(port: u16) -> Option<chrome::Browser> {
    chrome::chrome_bin()?;
    let profile = std::env::temp_dir().join(format!("brain-browser-test-{port}"));
    let b = chrome::Browser::open(&chrome::Launch { port, profile, headless: true }).await.expect("chrome opens");
    b.navigate(&fixture()).await.expect("fixture loads");
    Some(b)
}

/// Each test starts its own headless Chrome; close it so none are left running.
async fn close(b: chrome::Browser) {
    let _ = b.cdp.send("Browser.close", serde_json::json!({}), None).await;
}

/// The index of the line that contains `needle`, read from the page the model was shown.
fn index_of(prompt: &str, needle: &str) -> usize {
    let line = prompt.lines().find(|l| l.contains(needle) && l.contains("]<")).unwrap_or_else(|| panic!("{needle} not in:\n{prompt}"));
    let start = line.find('[').unwrap() + 1;
    line[start..start + line[start..].find(']').unwrap()].parse().unwrap()
}

/// Answers from the page it is shown, like a model would, and keeps every prompt.
struct Scripted {
    prompts: Mutex<Vec<String>>,
}

#[async_trait]
impl StepModel for Scripted {
    async fn ask(&self, _system: &str, prompt: &str, _shot: Option<&std::path::Path>) -> Result<String, String> {
        let n = {
            let mut p = self.prompts.lock().unwrap();
            p.push(prompt.to_string());
            p.len()
        };
        Ok(match n {
            // An answer the agent cannot read: it asks again.
            1 => "Sure, I will fill the form.".into(),
            2 => format!(
                r#"```json
{{"evaluation_previous_goal":"Start","memory":"","next_goal":"Fill and send","current_plan_item":0,
"action":[{{"input":{{"index":{},"text":"<secret>name</secret>"}}}},{{"select_dropdown":{{"index":{},"text":"large"}}}},
{{"click":{{"index":{}}}}},{{"click":{{"index":{}}}}}]}}
```"#,
                index_of(prompt, "placeholder=Your name"),
                index_of(prompt, "<select"),
                index_of(prompt, "type=checkbox"),
                index_of(prompt, "Place order"),
            ),
            3 => r#"{"memory":"sent","next_goal":"Read result","action":[{"read_page":{}}]}"#.into(),
            _ => r#"{"action":[{"done":{"text":"Ordered a large pizza for <secret>name</secret>.","success":true}}]}"#.into(),
        })
    }
}

#[tokio::test]
async fn fills_and_sends_a_form() {
    let Some(mut b) = headless(9341).await else { return };
    let model = Scripted { prompts: Mutex::default() };
    let secrets = Secrets(vec![("name".into(), "Rania Haddad".into())]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = Task { task: "Order a large pizza with bacon".into(), plan: vec!["Fill the form".into(), "Send it".into()], ..Default::default() };
    let finish = agent::run(task, &mut b, &model, &secrets, &Control::default(), None, &tx).await;

    assert!(finish.success, "{finish:?}");
    // The unreadable answer was asked again within step 1.
    assert_eq!(finish.steps, 3);
    // The secret went into the page, never into the model's prompts or the result.
    let out = b.eval("document.getElementById('out').textContent").await.unwrap();
    assert_eq!(out, "Ordered: Rania Haddad, large, bacon");
    assert_eq!(finish.text, "Ordered a large pizza for <secret>name</secret>.");
    let prompts = model.prompts.lock().unwrap();
    assert!(prompts.iter().all(|p| !p.contains("Rania Haddad")));
    assert!(prompts[3].contains("Ordered: <secret>name</secret>, large, bacon"), "read_page shows in the next step");
    assert!(prompts[1].contains("could not be read"), "a bad answer is asked again");
    // Passwords and hidden elements never reach the model.
    assert!(!prompts[1].contains("hunter22"));
    assert!(!prompts[1].contains("Hidden button"));

    let mut kinds = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        kinds.push(ev["type"].as_str().unwrap().to_string());
    }
    assert_eq!(kinds.iter().filter(|k| *k == "action").count(), 5);
    assert_eq!(kinds.last().unwrap(), "done");
    close(b).await;
}

#[tokio::test]
async fn says_the_secret_to_the_user_but_logs_the_placeholder() {
    let Some(mut b) = headless(9346).await else { return };
    struct Done;
    #[async_trait]
    impl StepModel for Done {
        async fn ask(&self, _s: &str, _p: &str, _shot: Option<&std::path::Path>) -> Result<String, String> {
            Ok(r#"{"action":[{"done":{"text":"Booked for <secret>name</secret>.","success":true}}]}"#.into())
        }
    }
    let secrets = Secrets(vec![("name".into(), "Rania Haddad".into())]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let finish = agent::run(Task { task: "x".into(), ..Default::default() }, &mut b, &Done, &secrets, &Control::default(), None, &tx).await;
    assert_eq!(finish.text, "Booked for <secret>name</secret>.");
    let mut done = serde_json::Value::Null;
    while let Ok(ev) = rx.try_recv() {
        done = ev;
    }
    assert_eq!(done["text"], "Booked for Rania Haddad.");
    close(b).await;
}

/// Always clicks something that is not there.
struct Lost;

#[async_trait]
impl StepModel for Lost {
    async fn ask(&self, _s: &str, prompt: &str, _shot: Option<&std::path::Path>) -> Result<String, String> {
        if prompt.contains("use only the done action") {
            return Ok(r#"{"memory":"The button was never found.","action":[{"click":{"index":999}}]}"#.into());
        }
        Ok(r#"{"action":[{"click":{"index":999}}]}"#.into())
    }
}

#[tokio::test]
async fn gives_up_after_repeated_failures() {
    let Some(mut b) = headless(9342).await else { return };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let task = Task { task: "Click the missing button".into(), max_steps: Some(20), ..Default::default() };
    let finish = agent::run(task, &mut b, &Lost, &Secrets::default(), &Control::default(), None, &tx).await;
    assert!(!finish.success);
    // Five failed steps, then the step that may only call done.
    assert_eq!(finish.steps, 6);
    assert!(finish.text.contains("never found"), "{}", finish.text);
    close(b).await;
}

#[tokio::test]
async fn stops_when_asked() {
    let Some(mut b) = headless(9343).await else { return };
    let control = Control::default();
    control.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let finish = agent::run(Task { task: "x".into(), ..Default::default() }, &mut b, &Lost, &Secrets::default(), &control, None, &tx).await;
    assert_eq!(finish.steps, 0);
    assert!(!finish.success);
    close(b).await;
}

#[tokio::test]
async fn lists_dropdown_options_and_keys() {
    let Some(mut b) = headless(9344).await else { return };
    let page = actions::page_state(&b).await.unwrap();
    let select = index_of(&page.text, "<select");
    let o = actions::run(&mut b, &actions::Action::DropdownOptions { index: select }, None, &[]).await.unwrap();
    assert!(o.read.unwrap().contains("1: Large"));
    let name = index_of(&page.text, "placeholder=Your name");
    actions::run(&mut b, &actions::Action::Input { index: name, text: "ab".into(), clear: true }, None, &[]).await.unwrap();
    actions::run(&mut b, &actions::Action::SendKeys { keys: "Backspace".into() }, None, &[]).await.unwrap();
    let v = b.eval("document.querySelector('[name=who]').value").await.unwrap();
    assert_eq!(v, "a");
    close(b).await;
}

#[test]
fn reads_fenced_or_bare_json() {
    let o = agent::parse_output("Here:\n```json\n{\"next_goal\":\"x\",\"action\":[{\"go_back\":{}}]}\n```").unwrap();
    assert_eq!(o.next_goal, "x");
    let a: actions::Action = serde_json::from_value(o.action[0].clone()).unwrap();
    assert_eq!(a, actions::Action::GoBack {});
    assert!(agent::parse_output("no json here").is_err());
}

/// The real thing: Claude plans and fills the form. Run with `cargo test --test browser_agent -- --ignored`.
#[tokio::test]
#[ignore = "calls Claude Code on the subscription"]
async fn claude_fills_the_form() {
    let Some(mut b) = headless(9345).await else { return };
    let model = nemo_realtime_voice::browser::claude();
    let secrets = Secrets(vec![("name".into(), "Rania Haddad".into())]);
    let task = "On the open page, order a large pizza with bacon for my name, then tell me what the page says.";
    let planned = nemo_realtime_voice::browser::plan(&model, task, &secrets).await.expect("a plan");
    eprintln!("plan: {planned}");
    let plan = planned["plan"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let printer = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            eprintln!("{ev}");
        }
    });
    let finish = agent::run(Task { task: task.into(), plan, max_steps: Some(8), ..Default::default() }, &mut b, &model, &secrets, &Control::default(), None, &tx).await;
    drop(tx);
    let _ = printer.await;
    let out = b.eval("document.getElementById('out').textContent").await.unwrap();
    close(b).await;
    assert_eq!(out, "Ordered: Rania Haddad, large, bacon", "{finish:?}");
    assert!(finish.success, "{finish:?}");
}

/// The app's browser clicks and types with pane.js (WebKit has no CDP). Here pane.js runs in
/// Chrome, everything else as in the app, so the same form must still get filled and sent.
struct JsPage(chrome::Browser);

#[async_trait]
impl nemo_realtime_voice::browser::page::Page for JsPage {
    async fn eval(&self, expression: &str) -> Result<serde_json::Value, String> {
        let raw = self.0.eval(&pane::PanePage::wrap(expression)).await?;
        pane::unwrap_value(&raw)
    }
    async fn navigate(&mut self, url: &str) -> Result<(), String> {
        self.0.navigate(url).await
    }
    async fn new_tab(&mut self, url: &str) -> Result<(), String> {
        self.0.navigate(url).await
    }
    async fn tabs(&self) -> Result<Vec<nemo_realtime_voice::browser::page::Tab>, String> {
        Ok(vec![nemo_realtime_voice::browser::page::Tab { id: "pane".into(), url: String::new(), title: String::new() }])
    }
    fn current(&self) -> String {
        "pane".into()
    }
    async fn switch(&mut self, _id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn close_tab(&mut self, _id: &str) -> Result<(), String> {
        Err("one tab".into())
    }
    async fn click_at(&self, x: f64, y: f64) -> Result<(), String> {
        self.eval(&format!("__brainPane.click({x}, {y})")).await.map(|_| ())
    }
    async fn insert_text(&self, text: &str) -> Result<(), String> {
        self.eval(&format!("__brainPane.type({})", serde_json::json!(text))).await.map(|_| ())
    }
    async fn key(&self, k: &nemo_realtime_voice::browser::page::Key) -> Result<(), String> {
        let spec = serde_json::json!({ "key": k.key, "code": k.code, "keyCode": k.key_code, "text": k.text, "modifiers": k.modifiers });
        self.eval(&format!("__brainPane.key({spec})")).await.map(|_| ())
    }
    async fn upload(&self, _i: usize, _p: &str) -> Result<(), String> {
        Err("no".into())
    }
    async fn screenshot(&self) -> Result<Vec<u8>, String> {
        Err("no".into())
    }
}

#[tokio::test]
async fn the_app_browser_fills_and_sends_a_form() {
    let Some(b) = headless(9347).await else { return };
    let mut page = JsPage(b);
    let model = Scripted { prompts: Mutex::default() };
    let secrets = Secrets(vec![("name".into(), "Rania Haddad".into())]);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let task = Task { task: "Order a large pizza with bacon".into(), plan: vec!["Fill the form".into()], ..Default::default() };
    let finish = agent::run(task, &mut page, &model, &secrets, &Control::default(), None, &tx).await;
    assert!(finish.success, "{finish:?}");
    let out = page.0.eval("document.getElementById('out').textContent").await.unwrap();
    assert_eq!(out, "Ordered: Rania Haddad, large, bacon");

    // Keys: Backspace edits the field, Enter sends the form.
    let state = actions::page_state(&page).await.unwrap();
    let name = index_of(&state.text, "placeholder=Your name");
    actions::run(&mut page, &actions::Action::Input { index: name, text: "Sami".into(), clear: true }, None, &[]).await.unwrap();
    actions::run(&mut page, &actions::Action::SendKeys { keys: "Backspace Enter".into() }, None, &[]).await.unwrap();
    let out = page.0.eval("document.getElementById('out').textContent").await.unwrap();
    assert_eq!(out, "Ordered: Sam, large, bacon");
    close(page.0).await;
}
