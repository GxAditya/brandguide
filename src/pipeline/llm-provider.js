/**
 * Which model the narration layer talks to, resolved from one caller's credentials.
 *
 *   gemini             Google's API: `x-goog-api-key` auth and an `input` /
 *                      `system_instruction` body. GEMINI_API_KEY, GEMINI_MODEL.
 *   openai-compatible  Any `/chat/completions` server. LLM_API_KEY, LLM_BASE_URL,
 *                      LLM_MODEL.
 *
 * `LLM_PROVIDER` overrides inference; without it a complete `LLM_*` trio wins over
 * a bare `GEMINI_API_KEY`, since three matching variables signal intent better than
 * one key left behind.
 *
 * The names are still environment-variable names, because that is what the shape
 * has always been and `src/server/creds.js` maps request headers onto exactly these
 * fields. What changed is where they come from: the caller's own request, never the
 * server's process environment. One deployment serves many keys at once, so nothing
 * here may read `process.env`.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/text-generation
 */

/**
 * The Interactions endpoint. `v1beta` is the path Google's own REST samples use,
 * and `interactions` is the current surface, replacing `models/{id}:generateContent`.
 */
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Model used when a Gemini key is present but no model was named, so a user who
 * only pasted a key gets a working layer.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

/** Current Gemini text models, newest first. Listed so a 404 can name the valid ids. */
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

/** Gemini 3 thinks by default, which costs latency and tokens; narration wants it low. */
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
 * Resolve the provider from one caller's credentials. Never throws: a bad value
 * returns `configured: false` with a `problem` naming the fix, since an optional
 * feature must never be why a guide fails to generate.
 *
 * @param {NodeJS.ProcessEnv} [creds]
 */
export function resolveLlm(creds = {}) {
  const explicit = clean(creds.LLM_PROVIDER);
  const { provider: requested, problem: badProvider } = normaliseProvider(explicit);

  if (badProvider) {
    return { provider: null, configured: false, problem: badProvider, apiKey: '', baseUrl: '', model: '' };
  }

  const openAiComplete = Boolean(clean(creds.LLM_API_KEY) && clean(creds.LLM_BASE_URL) && clean(creds.LLM_MODEL));
  const provider =
    requested || (openAiComplete ? 'openai-compatible' : geminiKey(creds) ? 'gemini' : null);

  if (!provider) {
    return { provider: null, configured: false, problem: null, apiKey: '', baseUrl: '', model: '' };
  }

  if (provider === 'gemini') {
    const apiKey = geminiKey(creds);
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

    const baseUrl = stripTrailingSlash(creds.GEMINI_BASE_URL || GEMINI_BASE_URL);
    // LLM_MODEL is accepted as a fallback so one variable can switch models
    // regardless of which provider is selected.
    const model = clean(creds.GEMINI_MODEL) || clean(creds.LLM_MODEL) || GEMINI_DEFAULT_MODEL;

    return {
      provider: 'gemini',
      configured: true,
      problem: null,
      apiKey,
      baseUrl,
      model,
      thinkingLevel: thinkingLevel(creds),
      endpoint: `${baseUrl}/interactions`,
    };
  }

  const apiKey = clean(creds.LLM_API_KEY);
  const baseUrl = stripTrailingSlash(creds.LLM_BASE_URL);
  const model = clean(creds.LLM_MODEL);

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