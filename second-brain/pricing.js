/**
 * OpenAI list prices for the GPT-6 models this app offers.
 *
 * Prices are US dollars per 1 million tokens, standard speed
 * (not the "fast" speed, which costs twice as much).
 * Checked against OpenAI's pricing page on 2 Oct 2026.
 *
 * Reasoning level is not a separate fee. A higher level makes the
 * model spend extra "thinking" tokens. Those tokens are already
 * included in the output token count and billed at the output price.
 *
 * If a request sends more than 272,000 input tokens, OpenAI charges
 * the whole request at the long-context rates: 2× input, 1.5× output.
 */

export const LONG_CONTEXT_TOKENS = 272_000;

export const REASONING_LEVELS = [
  { id: "none", label: "Off — fastest" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
];

export const VOICE_MODELS = [
  {
    id: "gpt-realtime-2.1-mini",
    label: "Voice mini",
    blurb: "Hears you. Same model as voice control.",
    hears: true,
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.06,
    outputPerMillion: 2.4,
    audioInputPerMillion: 10,
    audioCachedInputPerMillion: 0.3,
    audioOutputPerMillion: 20,
    reasoning: ["low", "medium", "high"],
  },
  {
    id: "gpt-realtime-2.1",
    label: "Voice",
    blurb: "Hears you. Stronger and more expensive.",
    hears: true,
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 24,
    audioInputPerMillion: 32,
    audioCachedInputPerMillion: 0.4,
    audioOutputPerMillion: 64,
    reasoning: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.8-live",
    label: "Gemini Live",
    blurb: "Google hears and speaks. Talk over it to cut it off.",
    hears: true,
    gemini: true,
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.75,
    outputPerMillion: 4.5,
    audioInputPerMillion: 3,
    audioCachedInputPerMillion: 3,
    audioOutputPerMillion: 12,
    reasoning: ["low"],
  },
];

export const MODELS = [
  {
    id: "claude-opus",
    // Same as Claude Sonnet below: runs through `claude -p` on your subscription.
    cliModel: "opus",
    label: "Claude Opus",
    blurb: "Most capable Claude. Uses your Claude subscription through Claude Code",
    subscription: true,
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    reasoning: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet",
    // Runs through the Claude Code app on this Mac (`claude -p`), so it uses the
    // Claude subscription you are logged in with, not an API key. Personal use only.
    cliModel: "sonnet",
    label: "Claude Sonnet",
    blurb: "Uses your Claude subscription through Claude Code. A few seconds slower to start",
    subscription: true,
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    reasoning: ["low", "medium", "high"],
  },
  {
    // Ollama name. Small vision model (about 2 billion parameters) that runs on this Mac.
    id: "bonsai-2:2b",
    label: "Bonsai 2",
    blurb: "Small model on this Mac. The written answer is free",
    local: true,
    hears: false,
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    reasoning: ["none", "low", "medium", "high"],
  },
  {
    // Ollama name. Already installed on this Mac. The written answer is free.
    id: "gpt-oss:20b",
    label: "GPT-OSS 20B",
    blurb: "Runs on this Mac, and the written answer is free",
    local: true,
    hears: false,
    // No length cap. The model stops when the answer is finished.
    uncapped: true,
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    // Ollama will not turn thinking fully off for this model, so Low is the least it can do.
    reasoning: ["low", "medium", "high"],
  },
];

export function getModel(id) {
  return MODELS.find((model) => model.id === id) || null;
}

export function getAnyModel(id) {
  return VOICE_MODELS.find((model) => model.id === id) || getModel(id);
}

/**
 * Turn OpenAI's usage report into a dollar amount for one chat.
 * cached tokens are a subset of input tokens and use the cheaper rate.
 * reasoning tokens are a subset of output tokens, so they are not added again.
 */
export function priceForUsage(model, usage) {
  const inputTokens = usage?.input_tokens || 0;
  const cachedTokens = usage?.input_tokens_details?.cached_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens || 0;
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const longContext = inputTokens > LONG_CONTEXT_TOKENS;

  const inputRate = model.inputPerMillion * (longContext ? 2 : 1);
  const cachedRate = model.cachedInputPerMillion * (longContext ? 2 : 1);
  const outputRate = model.outputPerMillion * (longContext ? 1.5 : 1);

  const usd =
    (uncachedTokens / 1_000_000) * inputRate +
    (cachedTokens / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * outputRate;

  return {
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    longContext,
    inputRate,
    cachedRate,
    outputRate,
    usd,
  };
}
