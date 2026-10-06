/**
 * Bring your own key.
 *
 * BrandKit holds no credentials. A deployment ships with an empty jar and every
 * caller supplies their own TinyFish and LLM keys per request, in headers. The
 * server reads them, uses them for that one request, and lets them go: there is
 * no store, no session, and nothing to rotate. Two people using one deployment
 * spend their own quota, and a leaked database leaks nothing.
 *
 * Headers rather than a request body because the live progress endpoint is a GET,
 * and an EventSource cannot carry one. The query string was the other option and
 * was rejected: a secret in a URL lands in proxy logs and browser history.
 *
 * The LLM credential is normalised here into the same shape `resolveLlm` reads,
 * so provider selection stays a pure function in one file.
 */

/** Namespaced so an upstream proxy cannot collide with them. */
export const CRED_HEADERS = {
  tinyfishKey: 'x-brandkit-tinyfish-key',
  llmProvider: 'x-brandkit-llm-provider',
  llmKey: 'x-brandkit-llm-key',
  llmBase: 'x-brandkit-llm-base',
  llmModel: 'x-brandkit-llm-model',
  /**
   * A preset id from llm-presets.js. This is what makes a free key usable by
   * someone who does not know what a base URL is: the preset supplies it, and its
   * first listed model when none was named.
   */
  llmPreset: 'x-brandkit-llm-preset',
};

/** Every name above, for the CORS preflight. */
export const CRED_HEADER_LIST = Object.values(CRED_HEADERS).join(', ');

/**
 * Generous enough for any real key and short enough that a header cannot be used
 * to park a payload. A real TinyFish key is well under 100 characters.
 */
const MAX_KEY = 512;
const MAX_URL = 2048;
const MAX_MODEL = 128;

/** The two spellings the settings panel offers; anything else is left to resolveLlm. */
const PROVIDERS = new Set(['gemini', 'openai', 'openai-compatible']);

function header(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function bounded(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Read one request's credentials. Never throws: a missing or malformed credential
 * is an absent credential, and the pipeline already reports that as "no key".
 *
 * @returns {{ tinyfishKey: string, hasTinyfishKey: boolean, llm: object, hasLlmKey: boolean }}
 */
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

/**
 * Map the flat headers onto the variable-shaped object `resolveLlm` understands.
 *
 * A bare key with no provider is Gemini, which is the single-field setup worth
 * supporting in a form. An OpenAI-compatible server needs all three of its fields,
 * and an incomplete one is passed through half-built on purpose: `resolveLlm`
 * already reports that state by name, and inventing a second opinion here would
 * give the same mistake two different messages.
 */
function llmCredential({ provider, key, base, model, preset }) {
  if (!key) return {};

  // A preset names the provider too, so picking one is enough. `gemini` is the one
  // preset whose transport is not OpenAI-compatible, and it is checked first because
  // its model table is different.
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
    // Passed through unaltered so the alias table gets to name the unknown value.
    return { LLM_PROVIDER: provider, LLM_API_KEY: key, ...(base ? { LLM_BASE_URL: base } : {}) };
  }

  // A bare key with no preset means Gemini, which is the single-field setup worth
  // supporting in a form.
  return {
    GEMINI_API_KEY: key,
    ...(model ? { GEMINI_MODEL: model } : {}),
  };
}