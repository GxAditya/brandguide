/**
 * Gemini transport for the narration layer.
 *
 * Google does not serve `/chat/completions` on its own domain, so this speaks the
 * Interactions API: `x-goog-api-key` auth, an `input` / `system_instruction` body,
 * and a `steps[]` reply with no `choices[0].message.content`. That is why it cannot
 * be reached by pointing an OpenAI-compatible base URL at it.
 *
 * Two ladders here as well, and the model ladder is the important one:
 *
 *   - Body ladder: shed a field when the request is *refused* (400, 404, 422).
 *   - Model ladder: when the model is *unavailable* (429, 503), walk down
 *     GEMINI_FALLBACKS to another text model.
 *
 * Both were needed in practice. On the free tier `gemini-3.8-flash` returned 503
 * "high demand" for structured requests while `gemini-3.1-flash-lite` answered, and
 * the daily quota is 20 requests *per model* — so a caller who picked the flagship
 * and hit its limit could still succeed on a different model.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/text-generation
 */

import { GEMINI_MODELS, GEMINI_FALLBACKS, LIMITS } from './llm-presets.js';

const TEMPERATURE = 0.4;

/**
 * Higher than the OpenAI path because thinking tokens come out of the same budget: a
 * limit sized for a non-reasoning model truncates the JSON mid-object, and the
 * sanitiser then discards the whole narrative.
 */
const MAX_OUTPUT_TOKENS = 4096;

const TIMEOUT_MS = 90_000;

const UNAVAILABLE = new Set([429, 500, 502, 503, 504, 529]);
const REFUSED = new Set([400, 404, 405, 413, 415, 422]);

class GeminiError extends Error {
  constructor(message, { status = null, model = null } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.model = model;
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
 * `response_format` is the most likely to be refused by a proxy, `thinking_level`
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

/**
 * Pull a human-readable message out of Google's error body.
 *
 * Google answers with a bare `[{error:{code,message,status}}]` array rather than a
 * single object, so reading only the object shape surfaced the whole JSON array to
 * the user. Whitespace is collapsed for the same reason.
 */
function readErrorDetail(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = first?.error?.message ?? first?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    /* not JSON; fall through to the raw text */
  }
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function failureReason(res, model) {
  let detail = '';
  try {
    detail = readErrorDetail(await res.text());
  } catch {
    detail = '';
  }

  // A 429 on the free tier is a fact about the plan, not a bad key. Saying so is the
  // difference between someone waiting and someone giving up on their setup.
  if (res.status === 429) {
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Try again in ${retryAfter >= 3600 ? `${Math.round(retryAfter / 3600)}h` : `${Math.ceil(retryAfter / 60)}m`}.`
      : '';
    return `${model} is rate limited.${wait} ${LIMITS.gemini}`;
  }

  if (res.status === 503) {
    return `${model} is at capacity right now (503). Another model is tried next.`;
  }

  if (res.status === 404) {
    return `HTTP 404: ${model} was not found. Known text models: ${Object.keys(GEMINI_MODELS).join(', ')}.`;
  }

  // A rejected key is the most common failure on a free tier, and it is worth naming
  // as such instead of leaving the reader to infer it from a status line.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return `HTTP ${res.status}: ${detail || 'the provider rejected that key'}`;
  }

  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt, retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  // Google's daily-limit retry-after is measured in hours. Sitting through one would
  // hold a request open far past any sensible timeout, so it is reported, not waited.
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 20_000);
  return 600 * 2 ** attempt + Math.floor(Math.random() * 400);
}

/** A wait this long means the limit is a daily one, so try a different model instead. */
function rateLimited(res) {
  const hinted = Number(res.headers?.get?.('retry-after'));
  return res.status === 429 && Number.isFinite(hinted) && hinted > 120;
}

/**
 * Call Gemini, degrading the body and then the model until one is accepted.
 *
 * @returns {Promise<string>} the model's raw text output
 * @throws {GeminiError} on transport failure or after every model and body is refused
 */
export async function callGemini(prompt, config) {
  const url = config.endpoint || `${config.baseUrl}/interactions`;

  // The caller's model first, then the fallbacks. Duplicates are dropped so a caller
  // who named a fallback model does not retry it twice.
  const models = [...new Set([config.model, ...GEMINI_FALLBACKS])].filter(Boolean);

  let firstRefusal = null;
  let lastUnavailable = null;

  for (const model of models) {
    const bodies = attempts({ model, system: prompt.system, user: prompt.user, config });
    let exhausted = false;

    for (const body of bodies) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'x-goog-api-key': config.apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (err) {
          lastUnavailable = `${model}: ${err?.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err?.message || 'network error'}`;
          if (attempt === 0) await sleep(backoff(attempt));
          continue;
        }

        if (res.ok) {
          const text = extractText(await res.json());
          if (text) return text;
          // A 200 with no text is a malformed reply, not something to solve by
          // shedding fields. Recorded and the ladder moves on, so a model that
          // answers badly does not hide a model that would have answered well.
          lastUnavailable = `${model} replied 200 with no text`;
          continue;
        }

        if (UNAVAILABLE.has(res.status)) {
          const reason = await failureReason(res, model);
          lastUnavailable = reason;

          // A daily quota on this model says nothing about the next model, and shedding
          // request fields cannot fix it either. Leave both ladders at once: any further
          // call here would spend quota that is already spent.
          if (rateLimited(res)) {
            exhausted = true;
            break;
          }

          if (attempt === 1) break;
          await sleep(backoff(attempt, res.headers?.get?.('retry-after')));
          continue;
        }

        if (REFUSED.has(res.status)) {
          const reason = await failureReason(res, model);
          // The *first* refusal is reported, because that is the caller's own model
          // and the one they typed. Reporting the last would name a fallback they
          // never asked for.
          firstRefusal = firstRefusal || reason;
          break;
        }

        throw new GeminiError(`Gemini returned ${await failureReason(res, model)}`, { status: res.status, model });
      }

      // This model's quota is gone for the day: no point trying a smaller body on it.
      if (exhausted) break;
    }
  }

  if (firstRefusal) throw new GeminiError(firstRefusal, { model: config.model });

  // Every model answered 200 and none produced text. Returning empty hands this to
  // narrate, which reports it as an unparseable reply — the same verdict a provider
  // returning prose we cannot parse gets, and the more useful one.
  if (lastUnavailable?.endsWith('with no text')) return '';

  throw new GeminiError(
    lastUnavailable || 'no model answered',
    { model: config.model },
  );
}