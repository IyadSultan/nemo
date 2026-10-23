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

/// Text models. Claude uses your subscription. Bonsai 2 runs free on this Mac.
pub const MODELS: &[Model] = &[
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
    // Ollama name. Small vision model that runs on this Mac. The written answer is free.
    Model {
        id: "bonsai-2:2b",
        label: "Bonsai 2",
        blurb: "Small model on this Mac. The written answer is free",
        local: Some(true),
        hears: Some(false),
        reasoning: LOCAL_LEVELS,
        ..BASE
    },
    // Ollama name. Already installed on this Mac. The written answer is free.
    // No length cap. Ollama will not turn thinking fully off, so Low is the least it can do.
    Model {
        id: "gpt-oss:20b",
        label: "GPT-OSS 20B",
        blurb: "Runs on this Mac, and the written answer is free",
        local: Some(true),
        hears: Some(false),
        uncapped: Some(true),
        reasoning: LMH,
        ..BASE
    },
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
