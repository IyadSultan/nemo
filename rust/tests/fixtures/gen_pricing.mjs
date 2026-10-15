// Regenerate: node rust/tests/fixtures/gen_pricing.mjs > rust/tests/fixtures/pricing.json
import * as p from "../../../second-brain/pricing.js";
const usages = [
  null,
  {},
  { input_tokens: 1200, output_tokens: 300 },
  { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 800, output_tokens_details: { reasoning_tokens: 500 } },
  { input_tokens: 300000, input_tokens_details: { cached_tokens: 100000 }, output_tokens: 20000 },
  { input_tokens: 272000, output_tokens: 1 },
  { input_tokens: 10, input_tokens_details: { cached_tokens: 50 }, output_tokens: 0 },
];
const ids = [...p.VOICE_MODELS, ...p.MODELS].map((m) => m.id);
const cases = [];
for (const id of ids) for (const u of usages) cases.push({ id, usage: u, result: p.priceForUsage(p.getAnyModel(id), u) });
console.log(JSON.stringify({
  longContextTokens: p.LONG_CONTEXT_TOKENS,
  reasoning: p.REASONING_LEVELS, voiceModels: p.VOICE_MODELS, models: p.MODELS,
  lookups: { getModelVoice: p.getModel("gpt-realtime-2.1"), getAnyVoice: p.getAnyModel("gpt-realtime-2.1")?.id, missing: p.getAnyModel("nope") },
  cases,
}, null, 1));
