/**
 * Which model the narration layer talks to, resolved from the environment.
 *
 * Two providers are supported and they do not speak the same protocol:
 *
 *   gemini             Google's own API. Auth is an `x-goog-api-key` header rather
 *                      than a bearer token, and the request body uses `input` /
 *                      `system_instruction` rather than Chat Completions messages.
 *                      Configure with GEMINI_API_KEY and GEMINI_MODEL.
 *
 *   openai-compatible  Any `/chat/completions` server: OpenAI, Groq, OpenRouter,
 *                      Together, Ollama. Configure with LLM_API_KEY, LLM_BASE_URL
 *                      and LLM_MODEL.
 *
 * Both are configured entirely from `.env`, so changing model or provider never
 * requires a code change. `LLM_PROVIDER` overrides inference; without it a
 * complete `LLM_*` trio wins over a bare `GEMINI_API_KEY`, because three matching
 * variables are a stronger signal of intent than one key someone left behind.
 *
 * Google docs: https://ai.google.dev/gemini-api/docs/text-generation
 *             https://ai.google.dev/gemini-api/docs/models
 */

/** Canonical provider ids. `gemini` speaks Google's API; the rest share one shape. */
export const LLM_PROVIDERS = ['gemini', 'openai-compatible'];

/**
 * The Interactions endpoint.
 *
 * `v1beta` is the path Google's own REST samples use. `interactions` is the
 * current surface, replacing the older `models/{id}:generateContent` call.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Model used when a Gemini key is present but no model was named.
 *
 * Gemini 3.8 Flash is the current stable flagship and the model Google's own
 * "for new projects, use this" guidance points at, so defaulting here means a
 * user who only pasted a key gets a working layer.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * Current Gemini text models, newest first.
 *
 * Kept in code for two reasons: a 404 from a mistyped id is a common enough
 * mistake to be worth naming, and model ids churn faster than the docs this
 * project ships with. Only text models are listed — the image, video, TTS and
 * embedding families cannot return the narrative object.
 */
export const GEMINI_MODELS = {
  'gemini-3.8-flash': 'Current stable flagship. The default here.',
  'gemini-3.5-flash-lite': 'Cheapest and fastest of the 3.x line.',
  'gemini-3.7-flash': 'Previous-generation Flash. Complex multi-step work.',
  'gemini-3.6-flash': 'Previous-generation Flash. Balanced speed and multimodal.',
  'gemini-3.5-flash': 'Legacy Flash. Baseline speed for routine workloads.',
  'gemini-3.1-flash-lite': 'Frontier-class quality at a fraction of the cost.',
  'gemini-3.1-pro-preview': 'Preview Pro. Highest capability, preview rate limits.',
};

/**
 * Google renamed the environment variable to GOOGLE_API_KEY in places, and both
 * spellings appear in their own docs. Accept either so a key copied from a Cloud
 * console is not silently ignored.
 */
const GEMINI_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** Spelling variants people actually type. Anything unmapped is an error, not a guess. */
const ALIASES = new Map([
  ['gemini', 'gemini'],
  ['google', 'gemini'],
  ['google-gemini', 'gemini'],
  ['googleai', 'gemini'],
  ['openai', 'openai-compatible'],
  ['openai-compatible', 'openai-compatible'],
  ['openaicompatible', 'openai-compatible'],
  ['chat-completions', 'openai-compatible'],
  ['compatible', 'openai-compatible'],
  ['custom', 'openai-compatible'],
]);

/**
 * Reasoning effort. Gemini 3 thinks by default, which costs latency and output
 * tokens; the model card guidance is to turn it down for extraction and
 * classification, which is exactly what narration is. `low` is therefore the
 * default and `GEMINI_THINKING_LEVEL` raises it when a user wants more.
 */
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const DEFAULT_THINKING_LEVEL = 'low';

function clean(value) {
  return String(value ?? '').trim();
}

function stripTrailingSlash(url) {
  return clean(url).replace(/\/+$/, '');
}

function geminiKey(env) {
  for (const name of GEMINI_KEY_VARS) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return '';
}

function thinkingLevel(env) {
  const raw = clean(env.GEMINI_THINKING_LEVEL).toLowerCase();
  if (!raw) return DEFAULT_THINKING_LEVEL;
  return THINKING_LEVELS.has(raw) ? raw : DEFAULT_THINKING_LEVEL;
}

function normaliseProvider(raw) {
  const key = clean(raw).toLowerCase();
  if (!key) return { provider: null, problem: null };
  if (ALIASES.has(key)) return { provider: ALIASES.get(key), problem: null };
  return {
    provider: null,
    problem:
      `Unknown LLM_PROVIDER "${clean(raw)}". ` +
      `Use "gemini" or "openai". Leave it unset to pick automatically.`,
  };
}

/**
 * Resolve the provider, and everything needed to call it, from the environment.
 *
 * Never throws. A bad value comes back as `configured: false` with a `problem`
 * that names the fix, because a missing optional feature must never be the
 * reason a brand guide fails to generate.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   provider: 'gemini'|'openai-compatible'|null,
 *   configured: boolean,
 *   problem: string|null,
 *   apiKey: string,
 *   baseUrl: string,
 *   model: string,
 *   thinkingLevel?: string,
 *   endpoint?: string,
 * }}
 */
export function resolveLlm(env = process.env) {
  const explicit = clean(env.LLM_PROVIDER);
  const { provider: requested, problem: badProvider } = normaliseProvider(explicit);

  if (badProvider) {
    return { provider: null, configured: false, problem: badProvider, apiKey: '', baseUrl: '', model: '' };
  }

  const openAiComplete = Boolean(clean(env.LLM_API_KEY) && clean(env.LLM_BASE_URL) && clean(env.LLM_MODEL));
  const provider =
    requested || (openAiComplete ? 'openai-compatible' : geminiKey(env) ? 'gemini' : null);

  if (!provider) {
    return { provider: null, configured: false, problem: null, apiKey: '', baseUrl: '', model: '' };
  }

  if (provider === 'gemini') {
    const apiKey = geminiKey(env);
    if (!apiKey) {
      return {
        provider: 'gemini',
        configured: false,
        problem: requested
          ? 'LLM_PROVIDER=gemini but GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey'
          : null,
        apiKey: '',
        baseUrl: '',
        model: '',
      };
    }

    const baseUrl = stripTrailingSlash(env.GEMINI_BASE_URL || GEMINI_BASE_URL);
    // LLM_MODEL is accepted as a fallback so one variable can switch models
    // regardless of which provider is selected.
    const model = clean(env.GEMINI_MODEL) || clean(env.LLM_MODEL) || GEMINI_DEFAULT_MODEL;

    return {
      provider: 'gemini',
      configured: true,
      problem: null,
      apiKey,
      baseUrl,
      model,
      thinkingLevel: thinkingLevel(env),
      endpoint: `${baseUrl}/interactions`,
    };
  }

  const apiKey = clean(env.LLM_API_KEY);
  const baseUrl = stripTrailingSlash(env.LLM_BASE_URL);
  const model = clean(env.LLM_MODEL);

  if (!apiKey || !baseUrl || !model) {
    const missing = [
      !apiKey && 'LLM_API_KEY',
      !baseUrl && 'LLM_BASE_URL',
      !model && 'LLM_MODEL',
    ].filter(Boolean);
    return {
      provider: 'openai-compatible',
      configured: false,
      problem: requested
        ? `LLM_PROVIDER=openai but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`
        : null,
      apiKey,
      baseUrl,
      model,
    };
  }

  return {
    provider: 'openai-compatible',
    configured: true,
    problem: null,
    apiKey,
    baseUrl,
    model,
    endpoint: `${baseUrl}/chat/completions`,
  };
}