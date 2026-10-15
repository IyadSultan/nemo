//! Rust port of `second-brain/pricing.js`.
//!
//! OpenAI list prices for the GPT-6 models this app offers.
//!
//! Prices are US dollars per 1 million tokens, standard speed
//! (not the "fast" speed, which costs twice as much).
//! Checked against OpenAI's pricing page on 2 Oct 2026.
//!
//! Reasoning level is not a separate fee. A higher level makes the
//! model spend extra "thinking" tokens. Those tokens are already
//! included in the output token count and billed at the output price.
//!
//! If a request sends more than 272,000 input tokens, OpenAI charges
//! the whole request at the long-context rates: 2× input, 1.5× output.

use serde::{Deserialize, Serialize};

pub const LONG_CONTEXT_TOKENS: u64 = 272_000;

#[derive(Debug, Serialize)]
pub struct ReasoningLevel {
    pub id: &'static str,
    pub label: &'static str,
}

pub const REASONING_LEVELS: &[ReasoningLevel] = &[
    ReasoningLevel { id: "none", label: "Off — fastest" },
    ReasoningLevel { id: "low", label: "Low" },
    ReasoningLevel { id: "medium", label: "Medium" },
    ReasoningLevel { id: "high", label: "High" },
    ReasoningLevel { id: "xhigh", label: "Extra high" },
    ReasoningLevel { id: "max", label: "Maximum" },
];

/// One selectable model. Optional flags are omitted from JSON when unset,
/// so `/api/models` returns the same shape as the Node server.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_model: Option<&'static str>,
    pub label: &'static str,
    pub blurb: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hears: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemini: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncapped: Option<bool>,
    pub input_per_million: f64,
    pub cached_input_per_million: f64,
    pub output_per_million: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_cached_input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_output_per_million: Option<f64>,
    pub reasoning: &'static [&'static str],
}

const ALL_LEVELS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const LMH: &[&str] = &["low", "medium", "high"];
const LOCAL_LEVELS: &[&str] = &["none", "low", "medium", "high"];

/// Defaults for the struct-update syntax below (`..BASE`).
const BASE: Model = Model {
    id: "",
    cli_model: None,
    label: "",
    blurb: "",
    subscription: None,
    local: None,
    hears: None,
    gemini: None,
    uncapped: None,
    input_per_million: 0.0,
    cached_input_per_million: 0.0,
    output_per_million: 0.0,
    audio_input_per_million: None,
    audio_cached_input_per_million: None,
    audio_output_per_million: None,
    reasoning: &[],
};

pub const VOICE_MODELS: &[Model] = &[
    Model {
        id: "gpt-realtime-2.1-mini",
        label: "Voice mini",
        blurb: "Hears you. Same model as voice control.",
        hears: Some(true),
        input_per_million: 0.6,
        cached_input_per_million: 0.06,
        output_per_million: 2.4,
        audio_input_per_million: Some(10.0),
        audio_cached_input_per_million: Some(0.3),
        audio_output_per_million: Some(20.0),
        reasoning: LMH,
        ..BASE
    },
    Model {
        id: "gpt-realtime-2.1",
        label: "Voice",
        blurb: "Hears you. Stronger and more expensive.",
        hears: Some(true),
        input_per_million: 4.0,
        cached_input_per_million: 0.4,
        output_per_million: 24.0,
        audio_input_per_million: Some(32.0),
        audio_cached_input_per_million: Some(0.4),
        audio_output_per_million: Some(64.0),
        reasoning: LMH,
        ..BASE
    },
    Model {
        id: "gemini-3.8-live",
        label: "Gemini Live",
        blurb: "Google hears and speaks. Talk over it to cut it off.",
        hears: Some(true),
        gemini: Some(true),
        input_per_million: 0.75,
        cached_input_per_million: 0.75,
        output_per_million: 4.5,
        audio_input_per_million: Some(3.0),
        audio_cached_input_per_million: Some(3.0),
        audio_output_per_million: Some(12.0),
        reasoning: &["low"],
        ..BASE
    },
];

/// A free model that runs on this Mac through Ollama.
const fn local(id: &'static str, label: &'static str, blurb: &'static str) -> Model {
    Model { id, label, blurb, local: Some(true), hears: Some(false), reasoning: LOCAL_LEVELS, ..BASE }
}

const LOCAL_BLURB: &str = "Runs on this Mac, and the written answer is free";

pub const MODELS: &[Model] = &[
    Model {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        blurb: "Cheapest and fastest",
        input_per_million: 0.1,
        cached_input_per_million: 0.01,
        output_per_million: 0.5,
        reasoning: ALL_LEVELS,
        ..BASE
    },
    Model {
        id: "gpt-6-sol",
        label: "GPT-6 Sol",
        blurb: "Stronger, and it can still skip thinking",
        input_per_million: 2.0,
        cached_input_per_million: 0.2,
        output_per_million: 10.0,
        reasoning: ALL_LEVELS,
        ..BASE
    },
    Model {
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        blurb: "Balanced. Thinking cannot be turned off",
        input_per_million: 2.0,
        cached_input_per_million: 0.1,
        output_per_million: 10.0,
        reasoning: THINKING_LEVELS,
        ..BASE
    },
    Model {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        blurb: "Most capable, and the most expensive",
        input_per_million: 10.0,
        cached_input_per_million: 1.0,
        output_per_million: 50.0,
        reasoning: THINKING_LEVELS,
        ..BASE
    },
    // Same as Claude Sonnet below: runs through `claude -p` on your subscription.
    Model {
        id: "claude-opus",
        cli_model: Some("opus"),
        label: "Claude Opus",
        blurb: "Most capable Claude. Uses your Claude subscription through Claude Code",
        subscription: Some(true),
        reasoning: THINKING_LEVELS,
        ..BASE
    },
    // Runs through the Claude Code app on this Mac (`claude -p`), so it uses the
    // Claude subscription you are logged in with, not an API key. Personal use only.
    Model {
        id: "claude-sonnet",
        cli_model: Some("sonnet"),
        label: "Claude Sonnet",
        blurb: "Uses your Claude subscription through Claude Code. A few seconds slower to start",
        subscription: Some(true),
        reasoning: LMH,
        ..BASE
    },
    local("MichelRosselli/bonsai-27b", "Bonsai 27B", LOCAL_BLURB),
    Model {
        // No token cap. The model stops when the answer is finished.
        uncapped: Some(true),
        // No "none": Ollama ignores think:false for GPT-OSS, so Low is its least thinking.
        reasoning: LMH,
        ..local("gpt-oss:20b", "GPT-OSS 20B", LOCAL_BLURB)
    },
    local("gemma4:12b-mlx", "Gemma 4 12B", LOCAL_BLURB),
    local("gemma4:e4b-mlx", "Gemma 4 E4B", "Smaller Gemma 4. Runs on this Mac, and the written answer is free"),
    local("gemma4:e2b-mlx", "Gemma 4 E2B", "Smallest Gemma 4. Runs on this Mac, and the written answer is free"),
    local("qwen3.8:27b-mlx", "Qwen 3.8 27B", LOCAL_BLURB),
];

pub fn get_model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn get_any_model(id: &str) -> Option<&'static Model> {
    VOICE_MODELS.iter().find(|m| m.id == id).or_else(|| get_model(id))
}

/// OpenAI's usage report. Missing fields count as zero.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Usage {
    pub input_tokens: u64,
    pub input_tokens_details: TokenDetails,
    pub output_tokens: u64,
    pub output_tokens_details: TokenDetails,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TokenDetails {
    pub cached_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub long_context: bool,
    pub input_rate: f64,
    pub cached_rate: f64,
    pub output_rate: f64,
    pub usd: f64,
}

/// Turn OpenAI's usage report into a dollar amount for one chat.
/// cached tokens are a subset of input tokens and use the cheaper rate.
/// reasoning tokens are a subset of output tokens, so they are not added again.
pub fn price_for_usage(model: &Model, usage: Option<&Usage>) -> Price {
    let empty = Usage::default();
    let u = usage.unwrap_or(&empty);
    let input_tokens = u.input_tokens;
    let cached_tokens = u.input_tokens_details.cached_tokens;
    let output_tokens = u.output_tokens;
    let uncached_tokens = input_tokens.saturating_sub(cached_tokens);
    let long_context = input_tokens > LONG_CONTEXT_TOKENS;

    let input_rate = model.input_per_million * if long_context { 2.0 } else { 1.0 };
    let cached_rate = model.cached_input_per_million * if long_context { 2.0 } else { 1.0 };
    let output_rate = model.output_per_million * if long_context { 1.5 } else { 1.0 };

    let usd = (uncached_tokens as f64 / 1_000_000.0) * input_rate
        + (cached_tokens as f64 / 1_000_000.0) * cached_rate
        + (output_tokens as f64 / 1_000_000.0) * output_rate;

    Price {
        input_tokens,
        cached_tokens,
        output_tokens,
        reasoning_tokens: u.output_tokens_details.reasoning_tokens,
        long_context,
        input_rate,
        cached_rate,
        output_rate,
        usd,
    }
}
