//! Golden test: Rust pricing must match `second-brain/pricing.js` exactly.
//! Fixture comes from `node rust/tests/fixtures/gen_pricing.mjs`.

use nemo_realtime_voice::pricing::*;
use serde_json::{json, Value};

fn raw_fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/pricing.json")).unwrap()
}

fn fixture() -> Value {
    norm(raw_fixture())
}

/// JS has one number type; serde_json keeps 10 and 10.0 apart. Compare as f64.
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        other => other,
    }
}

#[test]
fn model_lists_match_node() {
    let f = fixture();
    assert_eq!(norm(json!(LONG_CONTEXT_TOKENS)), f["longContextTokens"]);
    assert_eq!(norm(json!(REASONING_LEVELS)), f["reasoning"]);
    assert_eq!(norm(json!(VOICE_MODELS)), f["voiceModels"]);
    assert_eq!(norm(json!(MODELS)), f["models"]);
}

#[test]
fn lookups_match_node() {
    let f = fixture();
    // getModel only searches text models, so a voice id is not found.
    assert_eq!(norm(json!(get_model("gpt-realtime-2.1"))), f["lookups"]["getModelVoice"]);
    assert_eq!(norm(json!(get_any_model("gpt-realtime-2.1").map(|m| m.id))), f["lookups"]["getAnyVoice"]);
    assert_eq!(norm(json!(get_any_model("nope"))), f["lookups"]["missing"]);
}

#[test]
fn prices_match_node() {
    let f = raw_fixture();
    let cases = f["cases"].as_array().unwrap();
    // Seven usages per model (gen_pricing.mjs).
    assert_eq!(cases.len(), (VOICE_MODELS.len() + MODELS.len()) * 7);
    for c in cases {
        let model = get_any_model(c["id"].as_str().unwrap()).unwrap();
        let usage: Option<Usage> = serde_json::from_value(c["usage"].clone()).unwrap();
        let got = norm(json!(price_for_usage(model, usage.as_ref())));
        assert_eq!(got, norm(c["result"].clone()), "model {} usage {}", c["id"], c["usage"]);
    }
}
