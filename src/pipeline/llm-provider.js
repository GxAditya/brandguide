import { findPreset } from './llm-presets.js';

// Resolves which model the narration layer talks to, from one caller's credentials.
//   gemini            x-goog-api-key auth, input and system_instruction body.
//   openai-compatible Any /chat/completions server.
// The field names look like environment variables, but the values come from the
// caller's request headers, never from process.env. One deployment serves many keys.

// v1beta is the path Google's REST samples use. interactions replaces
// models/{id}:generateContent.
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// The steadiest model, not the flagship. On the free tier gemini-3.8-flash returns
// 503 for structured requests, so a caller who pasted only a key would get nothing.
export const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

// Model tables live in llm-presets.js so there is one list to keep current.
// Re-exported because llm-gemini.js and the settings panel read them from here.
export { GEMINI_MODELS, GEMINI_FALLBACKS, PRESETS, LIMITS } from './llm-presets.js';

// Google uses both spellings in its own docs, so accept either.
const GEMINI_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

// A preset's first listed model. Only a suggestion: a free tier rotates, and the
// transport walks down the list when one goes.
function presetDefaultModel(preset) {
  return preset?.models?.[0]?.id || '';
}

// Spellings people actually type. Anything unmapped is an error, not a guess.
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

// Gemini 3 thinks by default, which costs latency and tokens. Narration wants low.
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

// Never throws. A bad value returns configured: false with a problem that names
// the fix, because an optional layer must not stop a guide from generating.
export function resolveLlm(creds = {}) {
  const explicit = clean(creds.LLM_PROVIDER);
  const { provider: requested, problem: badProvider } = normaliseProvider(explicit);

  if (badProvider) {
    return { provider: null, configured: false, problem: badProvider, apiKey: '', baseUrl: '', model: '' };
  }

  const preset = findPreset(creds.LLM_PRESET);

  // A preset carries its own transport, so gemini resolves on a key alone.
  // Without this the code below would look for a Gemini key, find none, and report
  // the preset as unconfigured.
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
    // A key with no preset and no provider is a half finished setup. Name what is missing.
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

  // A preset names the transport as well, so Gemini by name reaches this branch.
  if (provider === 'gemini') {
    // The panel sends one spelling, a caller reading Google's docs may send the other.
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
    // LLM_MODEL works as a fallback, so one field can switch models for any provider.
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

  // A preset supplies the base URL, so the caller only sends a key. custom has none,
  // so that one still needs a base URL typed in.
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
    // Carried into the transport so it can name a limit, and the panel can show the tier.
    preset: creds.LLM_PRESET || null,
  };
}