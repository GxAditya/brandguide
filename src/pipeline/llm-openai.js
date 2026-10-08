// One code path serves every provider that implements the Chat Completions shape.
// Two ladders, because a failure means one of two very different things:
//   refused     400, 405, 413, 415, 422. Something in the request is wrong, so
//               retry the same call with one field less.
//   unavailable 429, 5xx. The provider is busy, so a smaller body cannot help and
//               would spend quota to prove it. Retry the same request with backoff.
// Treating those two the same was a real bug: one 429 on a daily free tier meant
// the request had already been tried four times, all refused.

import { LIMITS } from './llm-presets.js';

const TEMPERATURE = 0.4;

// Sized for a reasoning model, which spends part of its budget thinking before it
// answers, and those tokens come out of max_tokens. A chat sized cap truncates the
// JSON mid object, and the sanitiser then discards the narrative with no way to
// tell truncation from a bad answer. The measured pages never depend on this.
const MAX_TOKENS = 16_000;

const TIMEOUT_MS = 90_000;

// Transient by status: the request was fine, the provider was not.
const UNAVAILABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// Refused, so make less of the request. 404 is absent on purpose: shedding a field
// cannot create a model that does not exist. 401 and 403 are absent because a
// smaller body is still a rejected key. All three are in TERMINAL.
const REFUSED = new Set([400, 405, 413, 415, 422]);

// Changing the request cannot fix these, so report at once.
const TERMINAL = new Set([401, 403, 404, 410]);

class OpenAiCompatibleError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'OpenAiCompatibleError';
    this.status = status;
  }
}

// Fullest request first, each rung a subset of the one before, so an endpoint that
// implements only part of the OpenAI shape still works. The prompt rung is a superset
// rather than a subset, so it sits late, for NVIDIA NIM, whose sample carries an
// empty prompt beside messages.
function attempts({ model, system, user }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return [
    { model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, response_format: { type: 'json_object' }, messages },
    { model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages },
    // Reasoning models reject `max_tokens` in favour of `max_completion_tokens`.
    { model, temperature: TEMPERATURE, max_completion_tokens: MAX_TOKENS, messages },
    // Some gateways reject an explicit temperature; some also need an empty `prompt`
    // alongside `messages`, which is how NVIDIA's own sample is shaped.
    { model, max_tokens: MAX_TOKENS, messages },
    { model, prompt: '', messages },
    { model, messages },
  ];
}

export function extractText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content) return content;

  // Some gateways return content as an array of typed parts.
  if (Array.isArray(content)) {
    const joined = content
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('');
    if (joined) return joined;
  }

  // A reasoning model can return the answer under its own field with `content` null.
  const reasoning = body?.choices?.[0]?.message?.reasoning_content ?? body?.choices?.[0]?.reasoning;
  if (typeof reasoning === 'string' && reasoning) return reasoning;

  // OpenRouter reports usage on every reply and can answer on the first streamed chunk.
  if (typeof body?.output_text === 'string' && body.output_text) return body.output_text;

  return '';
}

// The shape is not standard. Most send {error:{message}}, some send a bare array,
// a few send plain text. Reading one shape left the rest as raw JSON, which is the
// least useful thing a failure message can be.
function readErrorDetail(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = first?.error?.message ?? first?.message ?? first?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    /* not JSON; fall through to the raw text */
  }
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function failureReason(res) {
  let detail = '';
  try {
    detail = readErrorDetail(await res.text());
  } catch {
    detail = '';
  }

  // The reset time matters more than the status. A 429 on a free tier is a fact about
  // the plan, so say when it clears rather than that the key is wrong.
  if (res.status === 429) {
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Try again in ${retryAfter >= 3600 ? `${Math.round(retryAfter / 3600)}h` : `${Math.ceil(retryAfter / 60)}m`}.`
      : '';
    return `HTTP 429: rate limited.${wait} ${LIMITS.openrouter}`;
  }

  if (res.status === 410) {
    return 'HTTP 410: this model has been retired by its provider. Pick another from the list in Settings.';
  }

  if (res.status === 404) {
    // NVIDIA sends a bare "404 page not found" with no detail, so do not read the body.
    return 'HTTP 404: no such model, or the base URL is wrong. Check the model list and the URL in Settings.';
  }

  if (res.status === 401 || res.status === 403) {
    return `HTTP ${res.status}: the provider rejected that key.${detail ? ` ${detail}` : ''}`;
  }

  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Google's retry-after on a daily free tier limit is eight hours, which no request
// should sit through, so a hint past a minute is reported instead of waited on.
function backoff(attempt, retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 60_000);
  return 600 * 2 ** attempt + Math.floor(Math.random() * 400);
}

// A wait this long means the limit is a daily one, so try another model instead.
function hopeless(retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  return Number.isFinite(hinted) && hinted > 120;
}

export async function callOpenAiCompatible(prompt, config) {
  const url = config.endpoint || `${config.baseUrl}/chat/completions`;
  const bodies = attempts({ model: config.model, system: prompt.system, user: prompt.user });

  let lastRefusal = null;
  let lastUnavailable = null;

  for (const body of bodies) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            // OpenRouter wants these two and ranks by referrer. Harmless elsewhere.
            'HTTP-Referer': 'https://brandkit.dev',
            'X-Title': 'BrandKit',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        lastUnavailable = err?.name === 'TimeoutError'
          ? `timed out after ${TIMEOUT_MS / 1000}s`
          : err?.message || 'network error';
        if (attempt < 2) await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        const text = extractText(await res.json());
        if (text) return text;
        // A 200 with no text is an empty completion or a reasoning shape arriving
        // differently than expected. Worth one more try, then give up.
        lastRefusal = 'HTTP 200 with no text in the reply';
        continue;
      }

      if (UNAVAILABLE.has(res.status)) {
        const reason = await failureReason(res);
        lastUnavailable = reason;

        const retryAfter = res.headers?.get?.('retry-after');
        if (hopeless(retryAfter) || attempt === 2) break;
        await sleep(backoff(attempt, retryAfter));
        continue;
      }

      if (REFUSED.has(res.status)) {
        // A smaller body is worth trying, so move to the next attempt.
        lastRefusal = await failureReason(res);
        break;
      }

      // A terminal status ends the call. Retrying or shrinking would spend quota to
      // reach the same answer, and on a daily free tier that quota is what is scarce.
      if (TERMINAL.has(res.status)) {
        const reason = await failureReason(res);
        throw new OpenAiCompatibleError(reason, { status: res.status });
      }

      throw new OpenAiCompatibleError(`LLM returned ${await failureReason(res)}`, { status: res.status });
    }
  }

  // Report the refusal, because it is the one the caller can act on. A provider that
  // was merely busy has already been retried three times.
  if (lastRefusal) throw new OpenAiCompatibleError(lastRefusal);
  throw new OpenAiCompatibleError(
    lastUnavailable ? `the provider was unavailable: ${lastUnavailable}` : 'no attempt succeeded',
  );
}