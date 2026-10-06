import { findPreset } from './llm-presets.js';

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
/**
 * Started at the steadiest model rather than the flagship.
 *
 * Measured on the free tier, `gemini-3.8-flash` answers a bare prompt but returns
 * 503 "high demand" for most structured requests, so a user who pasted only a key
 * would get nothing on their first run. `gemini-3.1-flash-lite` is in the same
 * family, costs less, and is the steadiest of the current text models. A caller who
 * wants the flagship names it, and the fallback ladder still catches them.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Model tables live in llm-presets.js, beside every other provider, so there is one
 * list to keep current rather than two that drift apart. Re-exported here because
 * llm-gemini.js and the settings panel both read them from this module.
 */
export { GEMINI_MODELS, GEMINI_FALLBACKS, PRESETS, LIMITS } from './llm-presets.js';

/**
 * Google renamed the environment variable to GOOGLE_API_KEY in places, and both
 * spellings appear in their own docs. Accept either so a key copied from a Cloud
 * console is not silently ignored.
 */
const GEMINI_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/**
 * A preset's first listed model, used when the caller sent a preset but no model.
 *
 * Only ever a *suggestion*: a free tier's catalogue rotates, and a model that is
 * live today can 404 tomorrow. When one goes, the transport falls back down the
 * list rather than failing, so this stays a starting point rather than a promise.
 */
function presetDefaultModel(preset) {
  return preset?.models?.[0]?.id || '';
}

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

  const preset = findPreset(creds.LLM_PRESET);

  // A preset carries its own transport, so `gemini` resolves to the Gemini branch on
  // a key alone. Without this the inference below would look for a Gemini key under its
  // own name, find none, and report the preset as unconfigured.
  const presetTransport = preset?.transport === 'gemini' ? 'gemini' : preset ? 'openai-compatible' : null;
  const hasKey = Boolean(geminiKey(creds) || clean(creds.LLM_API_KEY));

  const openAiComplete = Boolean(
    hasKey &&
      (clean(creds.LLM_BASE_URL) || preset?.baseUrl) &&
      (clean(creds.LLM_MODEL) || presetDefaultModel(preset)),
  );

  const provider =
    requested
    || presetTransport
    || (openAiComplete ? 'openai-compatible' : geminiKey(creds) ? 'gemini' : null);

  if (!provider) {
    // A key with no preset and no provider is a half-finished setup, and silence would
    // leave someone wondering why narration never appeared. Name what is missing.
    const key = geminiKey(creds) || clean(creds.LLM_API_KEY);
    const problem = !key
      ? null
      : preset && !preset.models?.length
        ? `The ${preset.label} preset has no model list, so it needs a base URL and a model as well as the key.`
        : `${preset ? `The ${preset.label} preset` : 'This narration key'} has no model and no base URL to use. Pick a provider with a model list in Settings, or send LLM_PRESET and LLM_MODEL.`;

    return {
      provider: null,
      configured: false,
      problem,
      apiKey: '',
      baseUrl: '',
      model: '',
      preset: creds.LLM_PRESET || null,
    };
  }

  // A preset names the transport as well as the endpoint, so picking Gemini by name
  // reaches this branch without the caller also sending LLM_PROVIDER.
  if (provider === 'gemini') {
    // Either spelling of the key: the Settings panel sends one, a caller reading
    // Google's docs may send the other.
    const apiKey = geminiKey(creds) || clean(creds.LLM_API_KEY);
    if (!apiKey) {
      return {
        provider: 'gemini',
        configured: false,
        problem: requested
          ? 'Gemini was chosen but no key was supplied. Get a free one at https://aistudio.google.com/apikey'
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
      preset: creds.LLM_PRESET || null,
    };
  }

  const apiKey = clean(creds.LLM_API_KEY);

  // A preset supplies its own base URL, so the caller only has to paste a key and
  // pick a model. `custom` carries no base URL, which is the case that still needs
  // one typed in.
  const baseUrl = stripTrailingSlash(creds.LLM_BASE_URL || preset?.baseUrl || '');
  const model = clean(creds.LLM_MODEL || presetDefaultModel(preset));

  if (!apiKey || !baseUrl || !model) {
    const missing = [
      !apiKey && 'a key',
      !baseUrl && 'the base URL',
      !model && 'a model',
    ].filter(Boolean);
    return {
      provider: 'openai-compatible',
      configured: false,
      problem: `The narration layer needs ${missing.join(', ')}. ${requested ? 'Check the Settings panel. ' : ''}Pick a provider there, or send LLM_PRESET with your own base URL.`,
      apiKey,
      baseUrl,
      model,
      preset: creds.LLM_PRESET || null,
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
    // Carried into the transport so it can name the limit when one bites, and so
    // the settings panel can tell a user which tier they are on.
    preset: creds.LLM_PRESET || null,
  };
}