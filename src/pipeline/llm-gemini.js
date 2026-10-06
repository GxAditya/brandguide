/**
 * Gemini transport for the narration layer.
 *
 * Google does not serve `/chat/completions` on its own domain, so this speaks the
 * Interactions API: `x-goog-api-key` auth, an `input` / `system_instruction` body,
 * and a `steps[]` reply with no `choices[0].message.content`. That is why it cannot
 * be pointed at by `LLM_BASE_URL`.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/text-generation
 */

import { GEMINI_MODELS } from './llm-provider.js';

/**
 * Higher than the OpenAI path because thinking tokens come out of the same budget:
 * a limit sized for a non-reasoning model truncates the JSON mid-object, and the
 * sanitiser then discards the whole narrative.
 */
const MAX_OUTPUT_TOKENS = 4096;

const TEMPERATURE = 0.4;
const TIMEOUT_MS = 90_000;

class GeminiError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/** Passed as `response_format.schema`. All but `toneSummary` is optional so a truncated reply still parses. */
const NARRATIVE_SCHEMA = {
  type: 'object',
  properties: {
    toneSummary: { type: 'string', description: '2-3 sentences on how this brand writes.' },
    pillars: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'A verbatim quote from the supplied copy.' },
        },
        required: ['name', 'claim'],
      },
    },
    positioning: { type: 'string' },
    doNext: { type: 'array', items: { type: 'string' } },
    watchOuts: { type: 'array', items: { type: 'string' } },
  },
  required: ['toneSummary'],
};

/**
 * Attempt ladder, fullest request first, each a strict subset of the one before.
 * `response_format` is the most likely to be refused by a proxy and `thinking_level`
 * the least, so they go first.
 */
function attempts({ model, system, user, config }) {
  const base = { model, input: user, system_instruction: system };
  const generationConfig = { temperature: TEMPERATURE, max_output_tokens: MAX_OUTPUT_TOKENS };
  if (config.thinkingLevel) generationConfig.thinking_level = config.thinkingLevel;
  const structured = { type: 'text', mime_type: 'application/json', schema: NARRATIVE_SCHEMA };

  return [
    { ...base, generation_config: generationConfig, response_format: structured },
    { ...base, generation_config: generationConfig },
    { ...base, generation_config: { temperature: TEMPERATURE, max_output_tokens: MAX_OUTPUT_TOKENS } },
    { ...base },
  ];
}

/** `steps` is current; `candidates` is the older shape a proxy or Vertex endpoint may still return. */
export function extractText(body) {
  if (Array.isArray(body?.steps)) {
    const text = body.steps
      .filter((step) => step?.type === 'model_output' || step?.type === undefined)
      .flatMap((step) => (Array.isArray(step?.content) ? step.content : []))
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text) return text;
  }

  // `output_text` is an SDK convenience property, not a REST field, but a proxy
  // that adds it costs nothing to read.
  if (typeof body?.output_text === 'string' && body.output_text) return body.output_text;
  const parts = body?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  return '';
}

/** Google's errors are JSON with a useful `error.message`. Surface it. */
async function failureReason(res) {
  let detail = '';
  try {
    const raw = await res.text();
    detail = raw ? String(JSON.parse(raw)?.error?.message || raw).slice(0, 300) : '';
  } catch {
    detail = '';
  }

  let reason = `HTTP ${res.status}`;
  if (detail) reason += `: ${detail}`;
  // A bad model id is the single most common Gemini mistake, and the id is the
  // part of the 404 message that gets truncated, so say it here.
  if (res.status === 404) reason += ` Known text models: ${Object.keys(GEMINI_MODELS).join(', ')}.`;
  return reason;
}

/**
 * Call Gemini once, degrading the request until the server accepts it.
 *
 * @returns {Promise<string>} the model's raw text output
 * @throws {GeminiError} on transport failure or after every attempt is refused
 */
export async function callGemini(prompt, config) {
  const url = config.endpoint || `${config.baseUrl}/interactions`;
  const bodies = attempts({ model: config.model, system: prompt.system, user: prompt.user, config });

  let last = null;

  for (const body of bodies) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) {
      const payload = await res.json();
      return extractText(payload);
    }

    last = await failureReason(res);
  }

  throw new GeminiError(`Gemini returned ${last}`, { status: null });
}