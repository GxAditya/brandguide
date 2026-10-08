// Google does not serve /chat/completions on its own domain, so this speaks the
// Interactions API: x-goog-api-key auth, an input and system_instruction body, and a
// steps[] reply. That is why an OpenAI compatible base URL cannot reach it.
//
// Two ladders, and the model ladder is the one that matters. The body ladder sheds a
// field on a refusal (400, 404, 422). The model ladder walks down GEMINI_FALLBACKS
// when the model is unavailable (429, 503), because the free quota is charged per
// project and resets daily, so a caller who picked a busy model can still succeed.

import { GEMINI_MODELS, GEMINI_FALLBACKS, LIMITS } from './llm-presets.js';

const TEMPERATURE = 0.4;

// Higher than the OpenAI path because thinking tokens come out of the same budget. A
// cap sized for a non reasoning model truncates the JSON mid object.
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

// Passed as response_format.schema. All but toneSummary is optional, so a reply that
// was cut short still parses.
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

// Fullest request first, each rung a subset of the one before. response_format is the
// field a proxy refuses most often and thinking_level the least, so they go first.
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

// steps is the current shape. candidates is the older one a proxy or Vertex may return.
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

  // output_text is an SDK convenience property, not a REST field. Reading it is free.
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

// Google answers with a bare [{error:{code,message,status}}] array, so reading only
// the object shape surfaced the whole array to the user.
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

  // A 429 on the free tier is a fact about the plan, not a bad key. Say when it resets,
  // which is the difference between someone waiting and someone giving up.
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

  // A rejected key is the most common failure on a free tier. Name it rather than
  // leaving the reader to infer it from a status line.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return `HTTP ${res.status}: ${detail || 'the provider rejected that key'}`;
  }

  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt, retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  // Google's daily limit retry-after is measured in hours, so report it, do not wait.
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 20_000);
  return 600 * 2 ** attempt + Math.floor(Math.random() * 400);
}

// A wait this long means the limit is a daily one, so try another model.
function rateLimited(res) {
  const hinted = Number(res.headers?.get?.('retry-after'));
  return res.status === 429 && Number.isFinite(hinted) && hinted > 120;
}

// Degrades the body, then the model, until one is accepted. Throws GeminiError on a
// transport failure or after every model and body has been refused.
export async function callGemini(prompt, config) {
  const url = config.endpoint || `${config.baseUrl}/interactions`;

  // The caller's model first, then the fallbacks. Duplicates are dropped so a caller
  // who named a fallback does not retry it twice.
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
          // A 200 with no text is a malformed reply, not something a field can fix. Record
          // it and move on, so a model that answers badly does not hide one that would
          // have answered well.
          lastUnavailable = `${model} replied 200 with no text`;
          continue;
        }

        if (UNAVAILABLE.has(res.status)) {
          const reason = await failureReason(res, model);
          lastUnavailable = reason;

          // A daily quota on this model says nothing about the next one, and shedding
          // fields cannot fix it. Leave both ladders: another call would spend quota
          // that is already spent.
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
          // The first refusal is reported, because that is the caller's own model. The
          // last would name a fallback they never asked for.
          firstRefusal = firstRefusal || reason;
          break;
        }

        throw new GeminiError(`Gemini returned ${await failureReason(res, model)}`, { status: res.status, model });
      }

      // This model's quota is gone for the day, so a smaller body cannot help.
      if (exhausted) break;
    }
  }

  if (firstRefusal) throw new GeminiError(firstRefusal, { model: config.model });

  // Every model answered 200 and none produced text. Return empty so narrate reports
  // an unparseable reply, which is the more useful verdict.
  if (lastUnavailable?.endsWith('with no text')) return '';

  throw new GeminiError(
    lastUnavailable || 'no model answered',
    { model: config.model },
  );
}