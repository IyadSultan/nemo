//! A team of helper agents for one answer, built on AutoAgents
//! (https://github.com/liquidos-ai/AutoAgents).
//!
//! 1. A quick planner (Sonnet 5.5) decides whether helpers are needed and
//!    splits the question into up to four separate jobs, or none when it is simple.
//! 2. One named helper per job runs at the same time on Claude Sonnet 5.5,
//!    never Opus. Helpers may read (never write) the selected folders.
//! 3. The lead reads what the helpers found and writes the answer, streamed.
//!
//! Every model call goes through Claude Code (`claude -p`) on the logged-in
//! Claude subscription, as the Node server does, so no API key is used.
//! `ClaudeCli` is an AutoAgents LLM provider that does exactly that.
//!
//! Events go out as they happen, so the page can show each helper as a small
//! avatar with its name: `team`, `agent`, `status`, `delta`, `usage`, `error`.

use async_trait::async_trait;
use autoagents::core::agent::prebuilt::executor::BasicAgent;
use autoagents::core::agent::task::Task;
use autoagents::core::agent::{AgentBuilder, DirectAgent};
use autoagents::llm::chat::{
    ChatMessage, ChatProvider, ChatResponse, ChatRole, StreamChoice, StreamDelta, StreamResponse,
    StructuredOutputFormat, Tool,
};
use autoagents::llm::completion::{CompletionProvider, CompletionRequest, CompletionResponse};
use autoagents::llm::embedding::EmbeddingProvider;
use autoagents::llm::error::LLMError;
use autoagents::llm::models::ModelsProvider;
use autoagents::llm::{LLMProvider, ToolCall};
use autoagents_derive::{agent, AgentHooks};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Helpers always run on this model.
pub const HELPER_MODEL: &str = "claude-sonnet-5-5";
/// At most this many helpers per answer.
pub const MAX_HELPERS: usize = 4;
/// Helper names and avatar colours, in the order they are handed out.
pub const CREW: &[(&str, &str)] = &[
    ("Ada", "#f28b66"),
    ("Milo", "#4fc1b0"),
    ("Juno", "#e8b44c"),
    ("Kai", "#9b8cf2"),
    ("Nova", "#5fb1f0"),
    ("Remy", "#9ccc65"),
];

const HELPER_TIMEOUT: Duration = Duration::from_secs(240);
const LEAD_TIMEOUT: Duration = Duration::from_secs(300);

/// Path of the Claude Code program. The server may start without ~/.local/bin on its PATH.
pub fn claude_bin() -> PathBuf {
    if let Ok(p) = std::env::var("CLAUDE_BIN") {
        return p.into();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    [format!("{home}/.local/bin/claude"), "/opt/homebrew/bin/claude".into()]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .unwrap_or_else(|| "claude".into())
}

/// Token counts across every call of one answer.
#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub output: u64,
}

/// What a helper is doing right now, for its avatar ("Reading notes.md").
pub type OnDoing = Arc<dyn Fn(String) + Send + Sync>;

/// An AutoAgents LLM provider that runs Claude Code (`claude -p`) on the subscription.
pub struct ClaudeCli {
    pub bin: PathBuf,
    pub model: String,
    /// Folders it may read. Empty: no tools at all.
    pub dirs: Vec<PathBuf>,
    pub effort: Option<String>,
    pub timeout: Duration,
    pub tokens: Arc<Mutex<Tokens>>,
    pub on_doing: Option<OnDoing>,
    /// Everything it writes and every tool it uses, for the helper's terminal on the page.
    pub on_log: Option<OnDoing>,
}

impl ClaudeCli {
    fn args(&self, system: &str) -> Vec<String> {
        let tools = if self.dirs.is_empty() { "" } else { "Read,Glob,Grep" };
        let mut a: Vec<String> = [
            "-p", "--model", &self.model, "--tools", tools, "--no-session-persistence",
            "--setting-sources", "", "--strict-mcp-config", "--system-prompt", system,
            "--output-format", "stream-json", "--include-partial-messages", "--verbose",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if !tools.is_empty() {
            a.extend(["--allowedTools".into(), tools.into()]);
        }
        if self.dirs.len() > 1 {
            a.push("--add-dir".into());
            a.extend(self.dirs[1..].iter().map(|d| d.display().to_string()));
        }
        if let Some(e) = &self.effort {
            a.extend(["--effort".into(), e.clone()]);
        }
        a
    }

    /// Run one call. Each piece of answer text goes to `on_text`; resolves with the whole text.
    async fn run(&self, messages: &[ChatMessage], mut on_text: impl FnMut(&str)) -> Result<String, LLMError> {
        let (system, prompt) = split_messages(messages);
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.args(self.args(&system))
            .current_dir(self.dirs.first().cloned().unwrap_or_else(std::env::temp_dir))
            // An API key here would bill the API instead of the subscription.
            .env_remove("ANTHROPIC_API_KEY")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| LLMError::Generic(format!("Could not start Claude Code ({e}). Is it installed and logged in?")))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| LLMError::Generic(e.to_string()))?;
        drop(stdin);
        let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut stderr = child.stderr.take().expect("piped stderr");

        let read = async {
            let mut text = String::new();
            let mut result: Option<Value> = None;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(piece) = text_delta(&msg) {
                    text.push_str(piece);
                    on_text(piece);
                    if let Some(log) = &self.on_log {
                        log(piece.to_string());
                    }
                }
                if let Some(say) = doing(&msg) {
                    if let Some(log) = &self.on_log {
                        log(format!("\n\x1b[2m› {say}\x1b[0m\n"));
                    }
                    if let Some(cb) = &self.on_doing {
                        cb(say);
                    }
                }
                if msg["type"] == "result" {
                    result = Some(msg);
                }
            }
            (text, result)
        };
        let (text, result) = tokio::time::timeout(self.timeout, read)
            .await
            .map_err(|_| LLMError::Generic("Claude took too long.".into()))?;
        let _ = child.wait().await;
        match result {
            Some(r) if r["is_error"] != true => {
                let u = &r["usage"];
                let n = |k: &str| u[k].as_u64().unwrap_or(0);
                let mut t = self.tokens.lock().unwrap();
                t.input += n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
                t.cached += n("cache_read_input_tokens");
                t.output += n("output_tokens");
                // Some answers arrive only in the final result, never as deltas.
                if text.is_empty() {
                    let whole = r["result"].as_str().unwrap_or("").to_string();
                    on_text(&whole);
                    return Ok(whole);
                }
                Ok(text)
            }
            other => {
                let mut err = String::new();
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut err).await;
                let why = other
                    .and_then(|r| r["result"].as_str().map(str::to_string))
                    .unwrap_or_else(|| err.trim().to_string());
                let why: String = why.chars().take(200).collect();
                Err(LLMError::Generic(format!("Claude returned an error ({why}).")))
            }
        }
    }
}

/// System messages become the system prompt; the rest is the prompt.
pub fn split_messages(messages: &[ChatMessage]) -> (String, String) {
    let system: Vec<&str> = messages.iter().filter(|m| m.role == ChatRole::System).map(|m| m.content.as_str()).collect();
    let rest: Vec<&ChatMessage> = messages.iter().filter(|m| m.role != ChatRole::System).collect();
    let prompt = if rest.len() == 1 {
        rest[0].content.clone()
    } else {
        rest.iter()
            .map(|m| format!("{}: {}", if m.role == ChatRole::Assistant { "Assistant" } else { "User" }, m.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    (system.join("\n\n"), prompt)
}

/// Text from the main agent only (Claude Code's own sub-agents are not part of the answer).
fn text_delta(msg: &Value) -> Option<&str> {
    if !msg["parent_tool_use_id"].is_null() || msg["type"] != "stream_event" {
        return None;
    }
    let ev = &msg["event"];
    if ev["type"] != "content_block_delta" || ev["delta"]["type"] != "text_delta" {
        return None;
    }
    ev["delta"]["text"].as_str().filter(|t| !t.is_empty())
}

/// "Reading x.md" / "Searching for y" from a tool call, for the helper's avatar.
pub fn doing(msg: &Value) -> Option<String> {
    if msg["type"] != "assistant" {
        return None;
    }
    let call = msg["message"]["content"].as_array()?.iter().rev().find(|c| c["type"] == "tool_use")?;
    let input = &call["input"];
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let short = |s: &str| s.chars().take(40).collect::<String>();
    Some(match call["name"].as_str()? {
        "Read" => format!("Reading {}", base(input["file_path"].as_str().unwrap_or("a file"))),
        "Grep" => format!("Searching for “{}”", short(input["pattern"].as_str().unwrap_or(""))),
        "Glob" => format!("Looking for {}", short(input["pattern"].as_str().unwrap_or("files"))),
        other => format!("Using {other}"),
    })
}

#[derive(Debug)]
struct Reply(String);

impl ChatResponse for Reply {
    fn text(&self) -> Option<String> {
        Some(self.0.clone())
    }
    fn tool_calls(&self) -> Option<Vec<ToolCall>> {
        None
    }
}

impl std::fmt::Display for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

type ChunkStream = Pin<Box<dyn futures::Stream<Item = Result<StreamResponse, LLMError>> + Send>>;

#[async_trait]
impl ChatProvider for ClaudeCli {
    async fn chat_with_tools(
        &self,
        messages: &[ChatMessage],
        _tools: Option<&[Tool]>,
        _json_schema: Option<StructuredOutputFormat>,
    ) -> Result<Box<dyn ChatResponse>, LLMError> {
        Ok(Box::new(Reply(self.run(messages, |_| {}).await?)))
    }

    async fn chat_stream_struct(
        &self,
        messages: &[ChatMessage],
        _tools: Option<&[Tool]>,
        _json_schema: Option<StructuredOutputFormat>,
    ) -> Result<ChunkStream, LLMError> {
        let (tx, rx) = mpsc::unbounded_channel::<Result<StreamResponse, LLMError>>();
        let me = self.clone_for_stream();
        let messages = messages.to_vec();
        tokio::spawn(async move {
            let piece = |t: &str| StreamResponse {
                choices: vec![StreamChoice {
                    delta: StreamDelta { content: Some(t.to_string()), reasoning_content: None, tool_calls: None },
                }],
                usage: None,
            };
            let out = tx.clone();
            if let Err(e) = me.run(&messages, move |t| { let _ = out.send(Ok(piece(t))); }).await {
                let _ = tx.send(Err(e));
            }
        });
        Ok(Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)))
    }

    fn model(&self) -> &str {
        &self.model
    }
}

impl ClaudeCli {
    fn clone_for_stream(&self) -> ClaudeCli {
        ClaudeCli {
            bin: self.bin.clone(),
            model: self.model.clone(),
            dirs: self.dirs.clone(),
            effort: self.effort.clone(),
            timeout: self.timeout,
            tokens: self.tokens.clone(),
            on_doing: self.on_doing.clone(),
            on_log: self.on_log.clone(),
        }
    }
}

#[async_trait]
impl CompletionProvider for ClaudeCli {
    async fn complete(&self, req: &CompletionRequest, _s: Option<StructuredOutputFormat>) -> Result<CompletionResponse, LLMError> {
        let msg = ChatMessage::user().content(req.prompt.clone()).build();
        Ok(CompletionResponse { text: self.run(&[msg], |_| {}).await? })
    }
}

#[async_trait]
impl EmbeddingProvider for ClaudeCli {
    async fn embed(&self, _input: Vec<String>) -> Result<Vec<Vec<f32>>, LLMError> {
        Err(LLMError::Generic("Claude Code does not make embeddings.".into()))
    }
}

#[async_trait]
impl ModelsProvider for ClaudeCli {}

impl LLMProvider for ClaudeCli {}

// ---- The three agents ----

#[agent(
    name = "planner",
    description = "You are the lead of a small team of research helpers. Read the user's request and the note excerpts. Decide whether separate helpers searching at the same time would give a better answer: for example notes, email and documents, several folders, or several distinct sub-questions. Simple questions need no helpers. Reply with JSON only, no other text: {\"helpers\": [{\"task\": \"one clear, self-contained job in one sentence\"}]}. Use at most 4 helpers; use an empty list when you can answer alone. The helpers are named Ada, Milo, Juno, Kai, Nova and Remy. When the latest request speaks to one of them by name (for example \"ask Ada how many files changed\" or \"Milo, check my email\"), reply with exactly that one helper and its name: {\"helpers\": [{\"name\": \"Ada\", \"task\": \"...\"}]}."
)]
#[derive(Clone, AgentHooks)]
pub struct Planner {}

#[agent(
    name = "helper",
    description = "You are one helper in a small research team. Do only your own job. Search and read the folders you can access when they may hold the answer. Reply with what you found: short plain facts, each with the file it came from. If you found nothing, say so in one line. Do not write the final answer for the user, and never invent facts."
)]
#[derive(Clone, AgentHooks)]
pub struct Helper {}

#[agent(
    name = "lead",
    description = "You lead a research team and write the final answer."
)]
#[derive(Clone, AgentHooks)]
pub struct Lead {}

// ---- Running a team ----

/// One answer's request, from the Node server.
#[derive(Deserialize, Debug, Clone)]
pub struct Request {
    /// Node's full system prompt for the final answer.
    pub system: String,
    /// Node's full prompt: note excerpts, conversation, the question.
    pub prompt: String,
    /// The lead's model for Claude Code (`opus`, `sonnet`).
    #[serde(default = "default_lead")]
    pub lead_model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub dirs: Vec<PathBuf>,
}

fn default_lead() -> String {
    "opus".into()
}

#[derive(Deserialize, Debug, Default, PartialEq)]
pub struct Plan {
    #[serde(default)]
    pub helpers: Vec<Job>,
}

#[derive(Deserialize, Debug, PartialEq)]
pub struct Job {
    pub task: String,
    /// Set when the user asked this helper by name ("ask Ada …").
    #[serde(default)]
    pub name: Option<String>,
}

/// Each helper's last job and what it found, so "ask Ada …" can build on it.
/// Kept in memory only; a restart forgets it.
static LAST_WORK: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());
/// How much of a helper's earlier findings it is reminded of.
const MEMORY_CHARS: usize = 4000;

fn remember(name: &str, task: &str, found: &str) {
    let mut last = LAST_WORK.lock().unwrap();
    last.retain(|(n, _, _)| n != name);
    last.push((name.into(), task.into(), found.chars().take(MEMORY_CHARS).collect()));
}

fn recall(name: &str) -> Option<(String, String)> {
    LAST_WORK.lock().unwrap().iter().find(|(n, _, _)| n == name).map(|(_, t, f)| (t.clone(), f.clone()))
}

/// Names and colours for the jobs. A job asked of a helper by name gets that helper;
/// the rest get the next free names, in crew order.
pub fn assign_crew(jobs: &[Job]) -> Vec<(String, String, String, bool)> {
    let wanted = |j: &Job| j.name.as_deref().and_then(|n| CREW.iter().find(|(c, _)| c.eq_ignore_ascii_case(n.trim())));
    let mut taken: Vec<&str> = Vec::new();
    let mut out: Vec<Option<(String, String, String, bool)>> = jobs
        .iter()
        .map(|j| match wanted(j) {
            Some((n, c)) if !taken.contains(n) => {
                taken.push(n);
                Some((n.to_string(), c.to_string(), j.task.trim().to_string(), true))
            }
            _ => None,
        })
        .collect();
    let mut free = CREW.iter().filter(|(n, _)| !taken.contains(n));
    for (slot, j) in out.iter_mut().zip(jobs) {
        if slot.is_none() {
            if let Some((n, c)) = free.next() {
                *slot = Some((n.to_string(), c.to_string(), j.task.trim().to_string(), false));
            }
        }
    }
    out.into_iter().flatten().collect()
}

/// The planner's JSON, even inside a ```json fence or with words around it.
pub fn parse_plan(text: &str) -> Plan {
    let start = text.find('{');
    let end = text.rfind('}');
    let mut plan: Plan = match (start, end) {
        (Some(s), Some(e)) if e > s => serde_json::from_str(&text[s..=e]).unwrap_or_default(),
        _ => Plan::default(),
    };
    plan.helpers.retain(|j| !j.task.trim().is_empty());
    plan.helpers.truncate(MAX_HELPERS);
    plan
}

/// The lead's prompt for the final answer: Node's prompt plus each helper's findings.
pub fn final_prompt(prompt: &str, found: &[(String, String, String)], asked: &[String]) -> String {
    if found.is_empty() {
        return prompt.to_string();
    }
    let mut out = format!("{prompt}\n\n---\nYour helpers searched in parallel. What they found:\n");
    for (name, task, text) in found {
        out.push_str(&format!("\n### {name}: {task}\n{}\n", text.trim()));
    }
    if asked.is_empty() {
        out.push_str("\nCombine these findings into one answer to the user's question. Do not mention the helpers by name.");
    } else {
        out.push_str(&format!(
            "\nThe user asked {} by name. Answer with what {} found, and say it comes from {}.",
            asked.join(" and "), asked.join(" and "), asked.join(" and ")
        ));
    }
    out
}

pub type Send_ = mpsc::UnboundedSender<Value>;

fn provider(model: &str, dirs: &[PathBuf], effort: Option<String>, timeout: Duration, tokens: &Arc<Mutex<Tokens>>, on_doing: Option<OnDoing>, on_log: Option<OnDoing>) -> Arc<ClaudeCli> {
    Arc::new(ClaudeCli {
        bin: claude_bin(),
        model: model.into(),
        dirs: dirs.to_vec(),
        effort,
        timeout,
        tokens: tokens.clone(),
        on_doing,
        on_log,
    })
}

async fn run_once<T>(agent: T, llm: Arc<ClaudeCli>, task: Task) -> Result<String, String>
where
    T: autoagents::core::agent::AgentDeriveT<Output = String> + autoagents::core::agent::AgentHooks + Clone,
{
    let handle = AgentBuilder::<_, DirectAgent>::new(BasicAgent::new(agent))
        .llm(llm)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    handle.agent.run(task).await.map_err(|e| e.to_string())
}

/// Run the whole team, sending events as they happen.
pub async fn run(req: Request, tx: Send_) {
    let tokens = Arc::new(Mutex::new(Tokens::default()));
    let send = |v: Value| { let _ = tx.send(v); };
    let dirs: Vec<PathBuf> = req.dirs.iter().filter(|d| d.is_dir()).cloned().collect();

    // 1. Plan.
    send(json!({ "type": "status", "message": "Deciding whether helpers are needed…" }));
    let planner = provider(HELPER_MODEL, &[], Some("low".into()), LEAD_TIMEOUT, &tokens, None, None);
    let plan = match run_once(Planner {}, planner, Task::new(req.prompt.clone())).await {
        Ok(text) => parse_plan(&text),
        Err(err) => {
            eprintln!("Team planner failed: {err}");
            Plan::default()
        }
    };

    // 2. Helpers, all at once.
    let assigned = assign_crew(&plan.helpers);
    let asked: Vec<String> = assigned.iter().filter(|a| a.3).map(|a| a.0.clone()).collect();
    let crew: Vec<(String, String, String)> = assigned.into_iter().map(|(n, c, t, _)| (n, c, t)).collect();
    let mut found: Vec<(String, String, String)> = Vec::new();
    if !crew.is_empty() {
        send(json!({
            "type": "team",
            "model": HELPER_MODEL,
            "agents": crew.iter().map(|(n, c, t)| json!({ "id": n.to_lowercase(), "name": n, "color": c, "task": t })).collect::<Vec<_>>(),
        }));
        send(json!({ "type": "status", "message": format!("Working with {} helper{}…", crew.len(), if crew.len() == 1 { "" } else { "s" }) }));
        let task_text = |t: &String| t.clone();
        let jobs = crew.iter().map(|(name, _, task)| {
            let id = name.to_lowercase();
            let tx = tx.clone();
            let on_doing: OnDoing = {
                let (tx, id) = (tx.clone(), id.clone());
                Arc::new(move |say: String| { let _ = tx.send(json!({ "type": "agent", "id": id, "state": "working", "doing": say })); })
            };
            let on_log: OnDoing = {
                let (tx, id) = (tx.clone(), id.clone());
                Arc::new(move |text: String| { let _ = tx.send(json!({ "type": "agent", "id": id, "log": text })); })
            };
            let llm = provider(HELPER_MODEL, &dirs, None, HELPER_TIMEOUT, &tokens, Some(on_doing), Some(on_log.clone()));
            let short = task_text(task);
            let earlier = recall(name)
                .map(|(t, f)| format!("\n\nEarlier in this chat your job was: {t}\nWhat you found then:\n{f}"))
                .unwrap_or_default();
            let task = Task::new(format!(
                "Your name is {name}. Your job: {task}{earlier}\n\nThe user's request and the note excerpts you were given:\n\n{}",
                req.prompt
            ));
            let (name, short_task) = (name.clone(), short);
            async move {
                let _ = tx.send(json!({ "type": "agent", "id": id, "state": "working", "doing": "Starting" }));
                on_log(format!("\x1b[1m{name}\x1b[0m on {HELPER_MODEL}\n\x1b[2mJob: {short_task}\x1b[0m\n\n"));
                match run_once(Helper {}, llm, task).await {
                    Ok(text) => {
                        on_log("\n\n\x1b[32m✓ Done\x1b[0m\n".into());
                        remember(&name, &short_task, &text);
                        let _ = tx.send(json!({ "type": "agent", "id": id, "state": "done", "doing": "Done" }));
                        Some((name, short_task, text))
                    }
                    Err(err) => {
                        eprintln!("Helper {name} failed: {err}");
                        on_log(format!("\n\n\x1b[31m✗ Could not finish: {err}\x1b[0m\n"));
                        let _ = tx.send(json!({ "type": "agent", "id": id, "state": "failed", "doing": "Could not finish" }));
                        None
                    }
                }
            }
        });
        found = futures::future::join_all(jobs).await.into_iter().flatten().collect();
        send(json!({ "type": "status", "message": "Putting the answer together…" }));
    }

    // 3. The lead writes the answer, streamed. With no helpers, the lead may read the folders itself.
    let lead_dirs = if crew.is_empty() { dirs.clone() } else { Vec::new() };
    let lead = provider(&req.lead_model, &lead_dirs, req.effort.clone(), LEAD_TIMEOUT, &tokens, None, None);
    let mut task = Task::new(final_prompt(&req.prompt, &found, &asked));
    task.system_prompt = Some(req.system.clone());
    let handle = AgentBuilder::<_, DirectAgent>::new(BasicAgent::new(Lead {}))
        .llm(lead)
        .stream(true)
        .build()
        .await;
    let mut failed = None;
    match handle {
        Ok(h) => match h.agent.run_stream(task).await {
            Ok(mut stream) => {
                // Pieces arrive one by one; the last item repeats the whole answer.
                let mut so_far = String::new();
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(piece) if piece.is_empty() || (!so_far.is_empty() && piece == so_far) => {}
                        Ok(piece) => {
                            so_far.push_str(&piece);
                            send(json!({ "type": "delta", "text": piece }));
                        }
                        Err(e) => { failed = Some(e.to_string()); break; }
                    }
                }
            }
            Err(e) => failed = Some(e.to_string()),
        },
        Err(e) => failed = Some(e.to_string()),
    }
    if let Some(err) = failed {
        eprintln!("Team lead failed: {err}");
        send(json!({ "type": "error", "message": "The team's lead could not write the answer." }));
    }
    let t = *tokens.lock().unwrap();
    send(json!({
        "type": "tokens",
        "input_tokens": t.input,
        "input_tokens_details": { "cached_tokens": t.cached },
        "output_tokens": t.output,
    }));
}
