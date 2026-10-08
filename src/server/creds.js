// BrandKit holds no credentials. Each caller sends its own keys per request, in headers.
// The server reads them, uses them for that one request, and drops them. Nothing is stored.
export const CRED_HEADERS = {
  // Namespaced so an upstream proxy cannot collide with them.
  tinyfishKey: 'x-brandkit-tinyfish-key',
  llmProvider: 'x-brandkit-llm-provider',
  llmKey: 'x-brandkit-llm-key',
  llmBase: 'x-brandkit-llm-base',
  llmModel: 'x-brandkit-llm-model',
  // A preset id from llm-presets.js. The preset supplies the base URL, so one key is enough.
  llmPreset: 'x-brandkit-llm-preset',
};

// Every header name above, for the CORS preflight.
export const CRED_HEADER_LIST = Object.values(CRED_HEADERS).join(', ');

// Long enough for any real key, short enough that a header cannot carry a payload.
const MAX_KEY = 512;
const MAX_URL = 2048;
const MAX_MODEL = 128;

// The two provider names the settings panel offers. resolveLlm names any other value.
const PROVIDERS = new Set(['gemini', 'openai', 'openai-compatible']);

function header(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function bounded(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

// Reads one request. Never throws: a missing credential is an absent credential.
export function readCreds(req) {
  const tinyfishKey = bounded(header(req, CRED_HEADERS.tinyfishKey), MAX_KEY);

  const provider = header(req, CRED_HEADERS.llmProvider).toLowerCase();
  const key = bounded(header(req, CRED_HEADERS.llmKey), MAX_KEY);
  const base = bounded(header(req, CRED_HEADERS.llmBase), MAX_URL);
  const model = bounded(header(req, CRED_HEADERS.llmModel), MAX_MODEL);
  const preset = bounded(header(req, CRED_HEADERS.llmPreset), 32).toLowerCase();

  return {
    tinyfishKey,
    hasTinyfishKey: Boolean(tinyfishKey),
    hasLlmKey: Boolean(key),
    llm: llmCredential({ provider, key, base, model, preset }),
  };
}

// Maps the flat headers onto the object resolveLlm reads.
// A bare key with no provider means Gemini, so the form needs one field.
// An incomplete OpenAI compatible server passes through as it is, because
// resolveLlm already names that state.
function llmCredential({ provider, key, base, model, preset }) {
  if (!key) return {};

  // A preset names the provider too, so one choice is enough.
  // Gemini is checked first because it is the one preset that is not OpenAI shaped.
  if (provider === 'gemini' || (preset === 'gemini' && provider !== 'openai' && provider !== 'openai-compatible')) {
    return {
      GEMINI_API_KEY: key,
      ...(preset ? { LLM_PRESET: preset } : {}),
      ...(model ? { GEMINI_MODEL: model } : {}),
    };
  }

  if (provider === 'openai' || provider === 'openai-compatible' || preset) {
    return {
      ...(provider ? { LLM_PROVIDER: 'openai-compatible' } : {}),
      LLM_API_KEY: key,
      ...(preset ? { LLM_PRESET: preset } : {}),
      ...(base ? { LLM_BASE_URL: base } : {}),
      ...(model ? { LLM_MODEL: model } : {}),
    };
  }

  if (provider && !PROVIDERS.has(provider)) {
    // Passed through as it is, so the alias table can name the unknown value.
    return { LLM_PROVIDER: provider, LLM_API_KEY: key, ...(base ? { LLM_BASE_URL: base } : {}) };
  }

  // A bare key with no preset means Gemini.
  return {
    GEMINI_API_KEY: key,
    ...(model ? { GEMINI_MODEL: model } : {}),
  };
}