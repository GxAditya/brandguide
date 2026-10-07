/**
 * Where the keys live: this browser, and nowhere else.
 *
 * BrandKit's server holds no credentials, so the browser is the only place one can
 * exist. They are kept in localStorage, sent as headers on each request, and never
 * written anywhere else — no cookie, no analytics, no sync. Clearing them here
 * forgets them for good.
 *
 * Storage can be refused: Safari private mode and a few embedded webviews throw on
 * localStorage rather than returning null. Rather than fail every run, the module
 * falls back to memory for the session and says so through `isPersistent()`, which
 * the settings panel states plainly instead of pretending the save will outlive
 * the tab.
 */

const STORAGE_KEY = 'brandkit.creds.v1';

/**
 * Narration providers, in the order the panel offers them: free tiers first, because
 * a visitor with no payment method can only use those.
 *
 * This mirrors `src/pipeline/llm-presets.js`. It is duplicated rather than fetched
 * because the panel must render before any request is made, and the catalogue is
 * small enough that a stale entry costs one failed run rather than a wrong answer.
 * `GET /api/v1` returns the server's copy, which is authoritative.
 */
export const PROVIDERS = [
  { value: '', label: 'None — measured pages only' },
  {
    value: 'gemini',
    label: 'Google Gemini',
    free: true,
    transport: 'gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'A key alone is enough. Narration uses whichever Gemini model has capacity, so a rate limit on one does not stop it.',
    models: [
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', note: 'steadiest on the free tier' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'flagship, often at capacity' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'older, very available' },
    ],
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    free: true,
    transport: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'One key, many models. Free models end in :free and rotate often — pick one from the list.',
    models: [
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
    value: 'groq',
    label: 'Groq',
    free: true,
    transport: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Very fast. The free plan covers only the ids below; the Llama models are enterprise-only.',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: 'about 500 tokens/s' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', note: 'preview' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: 'about 1000 tokens/s' },
    ],
  },
  {
    value: 'nvidia',
    label: 'NVIDIA NIM',
    free: true,
    transport: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/explore/discover',
    hint: 'Free hosted models, OpenAI-compatible. Retired models answer 410 Gone, so pick from the list.',
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
    value: 'cerebras',
    label: 'Cerebras',
    free: true,
    transport: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    hint: 'Free developer tier. Shared Inference now serves only the two models below.',
    models: [
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', note: 'about 3000 tokens/s' },
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    free: false,
    transport: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'Paid. These answer on /chat/completions; tool calling needs the Responses API.',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'near-Astra quality, lower cost' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'cheapest of the three' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'most capable, priciest' },
    ],
  },
  {
    value: 'mistral',
    label: 'Mistral',
    free: false,
    transport: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Paid.',
    models: [
      { id: 'mistral-medium-latest', label: 'Mistral Medium 3.5' },
      { id: 'mistral-small-latest', label: 'Mistral Small 4' },
      { id: 'mistral-large-latest', label: 'Mistral Large 4' },
    ],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    free: false,
    transport: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'Paid, very cheap. deepseek-chat and deepseek-reasoner are retired.',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', note: '1M context' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: '1M context' },
    ],
  },
  {
    value: 'custom',
    label: 'Something else',
    free: false,
    transport: 'openai',
    keyUrl: null,
    hint: 'Any OpenAI-compatible /chat/completions server. Type the base URL yourself.',
    models: [],
  },
];

const EMPTY = { tinyfishKey: '', llm: { preset: '', key: '', base: '', model: '' } };

/** Survives a storage refusal for the length of the session, and nothing longer. */
let memory = { ...EMPTY };
let persistent = true;

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Trim, and drop anything past the length the server will accept anyway. */
function text(value, max = 512) {
  const str = typeof value === 'string' ? value.trim() : '';
  return str.length > max ? str.slice(0, max) : str;
}

/** Never let a stored blob decide the shape; unknown fields are dropped here. */
function normalise(raw) {
  const llm = raw?.llm && typeof raw.llm === 'object' ? raw.llm : {};
  // A credential saved before presets existed carried a `provider`. Anything named
  // 'openai' or 'openai-compatible' was always the generic path, so it maps to the
  // custom entry and keeps its typed base URL.
  const storedPreset = text(llm.preset, 32).toLowerCase();
  const legacy = text(llm.provider, 32).toLowerCase();
  const preset = storedPreset
    || (legacy === 'gemini' ? 'gemini' : '')
    || (legacy === 'openai' || legacy === 'openai-compatible' ? 'custom' : '');

  const known = PROVIDERS.some((p) => p.value === preset);

  return {
    tinyfishKey: text(raw?.tinyfishKey),
    llm: {
      preset: known ? preset : '',
      key: text(llm.key),
      // Kept for the custom entry, which is the only one that needs a typed URL.
      base: text(llm.base, 2048),
      model: text(llm.model, 128),
    },
  };
}

/** The chosen provider's entry, or null for "no narration". */
export function findProvider(value) {
  return PROVIDERS.find((p) => p.value === value) || null;
}

export function loadCreds() {
  const local = store();
  if (!local) {
    persistent = false;
    return { ...memory };
  }

  try {
    const raw = local.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    memory = normalise(JSON.parse(raw));
  } catch {
    // A corrupt entry is not worth an exception: the user is simply not set up yet.
    memory = { ...EMPTY };
  }

  persistent = true;
  return { ...memory };
}

export function saveCreds(creds) {
  memory = normalise(creds);

  const local = store();
  if (!local) {
    persistent = false;
    return false;
  }

  try {
    local.setItem(STORAGE_KEY, JSON.stringify(memory));
    persistent = true;
  } catch {
    persistent = false;
  }
  return persistent;
}

export function clearCreds() {
  memory = { ...EMPTY };

  try {
    store()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to remove if storage was never available */
  }
}

export function isPersistent() {
  return persistent;
}

export function hasTinyfishKey() {
  return Boolean(loadCreds().tinyfishKey);
}

/**
 * True only when the key is there *and* the chosen provider has everything it needs.
 *
 * `custom` is the only one that needs a typed base URL, and `model` is optional
 * everywhere because a preset supplies a default and the transport falls back to
 * another model when that one is unavailable.
 */
export function hasLlmKey() {
  const { llm } = loadCreds();
  if (!llm.key || !llm.preset) return false;
  if (llm.preset === 'custom') return Boolean(llm.base);
  return true;
}

/**
 * The headers every call carries. Empty fields are omitted rather than sent blank,
 * so the server sees an absent credential instead of an empty one — the two mean
 * different things once it is resolving a provider.
 */
export function authHeaders() {
  const { tinyfishKey, llm } = loadCreds();
  const headers = {};

  if (tinyfishKey) headers['x-brandkit-tinyfish-key'] = tinyfishKey;
  if (llm.key) {
    headers['x-brandkit-llm-key'] = llm.key;
    if (llm.preset) headers['x-brandkit-llm-preset'] = llm.preset;
    if (llm.base) headers['x-brandkit-llm-base'] = llm.base;
    if (llm.model) headers['x-brandkit-llm-model'] = llm.model;
  }

  return headers;
}

/** Never the key itself: a mask long enough to tell two keys apart, short enough to be useless. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}${'•'.repeat(Math.min(16, key.length - 7))}${key.slice(-4)}`;
}