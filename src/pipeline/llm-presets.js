/**
 * Provider presets for the narration layer.
 *
 * Bring-your-own-key means someone has to type a base URL, and a mistyped one is
 * the single most likely reason a free key "doesn't work". These remove the typing:
 * pick a provider, get its base URL and a model known to be live today.
 *
 * Every entry here was checked against the provider's own models endpoint rather
 * than written from memory, because model ids rotate constantly. `free` marks a
 * tier that needs no payment method, which is what makes a preset worth having.
 *
 * Gemini is not in this table because it does not speak the Chat Completions shape.
 * It has its own transport and lives in llm-provider.js.
 */

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
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B' },
      { id: 'thinkingmachines/inkling:free', label: 'Inkling' },
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
    hint: 'Very fast, free developer tier. Model ids change often; any current one works.',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
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
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B', note: 'reasoning' },
      { id: 'nvidia/mistral-nemo-minitron-8b-8k-instruct', label: 'Minitron 8B' },
      { id: 'mistralai/mistral-large-2-instruct', label: 'Mistral Large 2' },
      { id: 'google/gemma-3-12b-it', label: 'Gemma 3 12B' },
      { id: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    transport: 'openai',
    free: true,
    baseUrl: 'https://api.cerebras.ai/v1',
    hint: 'Free developer tier with a fast open model.',
    keyUrl: 'https://cloud.cerebras.ai',
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B' },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    transport: 'openai',
    free: false,
    baseUrl: 'https://api.openai.com/v1',
    hint: 'Paid. Falls back to gpt-4o-mini when no model is given.',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
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
      { id: 'mistral-small-latest', label: 'Mistral Small' },
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'open-mistral-nemo', label: 'Nemo' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'openai',
    free: false,
    baseUrl: 'https://api.deepseek.com/v1',
    hint: 'Paid, very cheap.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
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

/**
 * Gemini models, newest first, with the ones that answer under load noted.
 *
 * `fallback: true` marks a model to try when the requested one is unavailable.
 * Capacity on the flash tier is bursty and shared, so the ladder walks down these
 * rather than reporting failure the first time a flagship returns 503.
 */
export const GEMINI_MODELS = {
  'gemini-3.8-flash': 'Current stable flagship. Busy at peak.',
  'gemini-3.8-flash-lite': 'Cheaper sibling of the flagship.',
  'gemini-3.5-flash-lite': 'Cheapest and fastest of the 3.x line.',
  'gemini-3.5-flash': 'Legacy Flash, balanced speed and volume.',
  'gemini-3.7-flash': 'Previous-generation Flash, complex multi-step work.',
  'gemini-3.1-flash-lite': 'Frontier-class quality, fraction of the cost. Steadiest under load.',
  'gemini-3.1-pro-preview': 'Preview Pro. Highest capability, preview rate limits.',
  'gemini-2.5-flash': 'Older but very available. The safest free fallback.',
};

/**
 * Tried in order when the caller's model is throttled, gone, or over capacity.
 *
 * Ordered by measured availability rather than by capability: on the free tier the
 * cheapest, oldest models answer most reliably, and a slightly plainer paragraph
 * beats no paragraph at all. Each entry must also exist in GEMINI_MODELS above, which
 * the tests assert, so the 404 message can list them.
 */
export const GEMINI_FALLBACKS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash-lite',
];

/** Live free-tier numbers, so a rate limit reads as advice rather than a failure. */
export const LIMITS = {
  gemini: 'Free tier: 20 requests per day per model. Exceeding it returns 429 with a retry-after in seconds.',
  openrouter: 'Free models are rate limited per model and rotate often. A 429 here is usually temporary.',
};

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}