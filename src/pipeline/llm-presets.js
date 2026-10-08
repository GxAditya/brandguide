// Pick a provider, get its base URL and a model known to be live, so nobody has to
// type a URL that a typo would break. free marks a tier that needs no payment method.
//
// Checked 7 October 2026. OpenRouter, NVIDIA NIM and Gemini were read from their live
// model list endpoints; Groq, Cerebras and DeepSeek from their docs; OpenAI and
// Mistral from their model pages. A stale id here is a failed run for the person who
// pasted a key, so re-check rather than trust this file.
//
// Gemini is not in this table because it does not speak the Chat Completions shape.
// It has its own transport, in llm-provider.js.

export const PRESETS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    transport: 'gemini',
    free: true,
    hint: 'A key alone is enough. Get one at aistudio.google.com/apikey.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openai',
    free: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'One key, many models. Free models end in :free and change often — the ones below are live now.',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      // The router resolves to whatever free model has capacity, so this preset cannot
      // go stale the way a pinned id does.
      { id: 'openrouter/free', label: 'Any free model', note: 'router, never goes stale' },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B' },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
      { id: 'thinkingmachines/inkling:free', label: 'Inkling' },
      { id: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning' },
      { id: 'liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    transport: 'openai',
    free: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    hint: 'Very fast. The free plan covers only the ids below; the Llama models are enterprise-only.',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'about 500 tokens/s' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', note: 'preview' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: 'about 1000 tokens/s' },
    ],
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    transport: 'openai',
    free: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    hint: 'Free hosted models with an OpenAI-compatible API. Retired models answer 410 Gone, so pick from the list.',
    keyUrl: 'https://build.nvidia.com/explore/discover',
    models: [
      { id: 'nvidia/nemotron-4-340b-instruct', label: 'Nemotron 4 340B' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B' },
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
      { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B' },
      { id: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'mistralai/mistral-large-2-instruct', label: 'Mistral Large 2' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B', note: 'reasoning' },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    transport: 'openai',
    free: true,
    baseUrl: 'https://api.cerebras.ai/v1',
    hint: 'Free developer tier. Shared Inference now serves only the two models below.',
    keyUrl: 'https://cloud.cerebras.ai',
    models: [
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', note: 'about 3000 tokens/s' },
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    transport: 'openai',
    free: false,
    baseUrl: 'https://api.openai.com/v1',
    hint: 'Paid. These answer on /chat/completions; tool calling needs the Responses API.',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'near-Astra quality, lower cost' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'cheapest of the three' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'most capable, priciest' },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    transport: 'openai',
    free: false,
    baseUrl: 'https://api.mistral.ai/v1',
    hint: 'Paid tier, cheapest models included.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-medium-latest', label: 'Mistral Medium 3.5' },
      { id: 'mistral-small-latest', label: 'Mistral Small 4' },
      { id: 'mistral-large-latest', label: 'Mistral Large 4' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'openai',
    free: false,
    baseUrl: 'https://api.deepseek.com/v1',
    hint: 'Paid, very cheap. deepseek-chat and deepseek-reasoner are retired.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', note: '1M context' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: '1M context' },
    ],
  },
  {
    id: 'custom',
    label: 'Something else (enter the base URL yourself)',
    transport: 'openai',
    free: false,
    hint: 'Any OpenAI-compatible /chat/completions server.',
    models: [],
  },
];

// Newest first. Checked against the live v1beta/models list on 7 October 2026: every
// id here must appear in it, because a retired id answers 404 and costs a whole run.
export const GEMINI_MODELS = {
  'gemini-3.8-flash': 'Current stable flagship. Busy at peak.',
  'gemini-3.7-flash': 'Previous-generation Flash, complex multi-step work.',
  'gemini-3.6-flash': 'Mid-generation Flash, balanced speed and volume.',
  'gemini-3.5-flash': 'Legacy Flash, balanced speed and volume.',
  'gemini-3.5-flash-lite': 'Cheapest and fastest of the 3.x line.',
  'gemini-3.1-flash-lite': 'Frontier-class quality, fraction of the cost. Steadiest under load.',
  'gemini-3.1-pro-preview': 'Preview Pro. Highest capability, preview rate limits.',
  'gemini-2.5-flash': 'Older but very available. The safest free fallback.',
};

// Ordered by measured availability, not capability: on the free tier the cheapest
// models answer most reliably, and a plainer paragraph beats no paragraph. Each entry
// must also be in GEMINI_MODELS, which the tests assert.
export const GEMINI_FALLBACKS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
];

// Live free tier numbers, so a rate limit reads as advice rather than a failure.
export const LIMITS = {
  gemini: 'Free tier limits are set per project and reset at midnight Pacific. The exact numbers for a model are shown in AI Studio, and preview models get the tightest limits.',
  openrouter: 'Free models are rate limited per model and rotate often. A 429 here is usually temporary.',
};

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}