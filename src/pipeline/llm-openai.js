/**
 * OpenAI-compatible transport for the narration layer.
 *
 * One code path serves every provider implementing the Chat Completions shape, which
 * is nearly all of them: OpenRouter, Groq, NVIDIA NIM, Cerebras, Mistral, DeepSeek,
 * Together, and a local Ollama.
 *
 * Two ladders, because a failure here means one of two very different things:
 *
 *   - The request was *refused* (400, 404, 422). Usually an unsupported field or a
 *     model id that no longer exists, so the same call is retried with less on it.
 *   - The provider was *unavailable* (429, 5xx). Trying a smaller body would be
 *     pointless and would spend the caller's quota to prove it, so these back off
 *     and retry the identical request instead.
 *
 * Conflating those two was a real bug: a 20-request-per-day free tier returning
 * 429 once meant the request had already been tried four times, all of them refused.
 */

import { LIMITS } from './llm-presets.js';

const TEMPERATURE = 0.4;

/**
 * Sized for a reasoning model, not a chat one.
 *
 * A reasoning model spends part of its budget thinking before it answers, and those
 * tokens come out of `max_tokens` — NVIDIA's own sample for a Nemotron reasoning model
 * asks for 65536 with a 16384 reasoning budget. A cap sized for a plain chat reply
 * truncates the JSON part-way through the object, and the sanitiser then throws away
 * the whole narrative with no way to tell truncation from a bad answer.
 *
 * The measured pages never depend on this, so an over-large cap costs nothing when a
 * provider bills by output and is refused harmlessly by one that does not.
 */
const MAX_TOKENS = 16_000;

const TIMEOUT_MS = 90_000;

/** Transient by status: the request was fine, the provider was not. */
const UNAVAILABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Refused: something about the *request* is wrong, so make less of it.
 *
 * 404 is deliberately absent. NVIDIA answers an unknown model id with a bare
 * `404 page not found`, and shedding `response_format` cannot conjure a model that
 * does not exist — it just spends four calls to reach the same conclusion. Absent
 * too is 401 and 403, which mean the key was rejected: a smaller body is still a
 * rejected key. All three terminate immediately below.
 */
const REFUSED = new Set([400, 405, 413, 415, 422]);

/** Terminal: the request cannot be fixed by changing it. Reported at once. */
const TERMINAL = new Set([401, 403, 404, 410]);

class OpenAiCompatibleError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'OpenAiCompatibleError';
    this.status = status;
  }
}

/**
 * Attempt ladder, fullest request first, each a strict subset of the one before.
 *
 * `response_format: json_object` is an OpenAI extension many compatible servers do not
 * implement; `max_tokens` was renamed `max_completion_tokens` for reasoning models;
 * some gateways reject an explicit temperature. Shedding one field at a time means an
 * endpoint implementing only part of the shape still works.
 *
 * The `prompt: ''` rung exists for NVIDIA NIM, whose documented sample carries an
 * empty `prompt` beside `messages`. It is a strict superset of the rung above rather
 * than a subset, which is why it sits late — reached only when everything simpler has
 * been refused.
 */
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

/** The Chat Completions reply is the one shape worth reading directly. */
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

/**
 * Pull a human-readable message out of a provider's error body.
 *
 * The shape is not standardised. OpenAI and most gateways send `{error:{message}}`;
 * some, Gemini included, send a bare `[{error:{...}}]` array; a few send plain text.
 * Reading only the first shape meant the other two arrived as a wall of raw JSON,
 * which is the least useful thing a failure message can be.
 */
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

  // The hint matters more than the status: a 429 on a free tier is a fact about the
  // plan, and someone hitting it needs to know it resets rather than that their key
  // is wrong.
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
    // NVIDIA answers an unknown model with a bare `404 page not found` and no detail,
    // which is why this message does not rely on the body at all.
    return 'HTTP 404: no such model, or the base URL is wrong. Check the model list and the URL in Settings.';
  }

  if (res.status === 401 || res.status === 403) {
    return `HTTP ${res.status}: the provider rejected that key.${detail ? ` ${detail}` : ''}`;
  }

  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff for an unavailable provider. Google's `retry-after` on a daily free-tier
 * limit is eight hours, which no request should ever sit through, so anything past
 * a minute is reported instead of waited on.
 */
function backoff(attempt, retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 60_000);
  return 600 * 2 ** attempt + Math.floor(Math.random() * 400);
}

/** A wait long enough that waiting is pointless. */
function hopeless(retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  return Number.isFinite(hinted) && hinted > 120;
}

/**
 * @returns {Promise<string>}
 * @throws {OpenAiCompatibleError}
 */
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
            // OpenRouter ranks by referrer and is explicit about wanting these two.
            // Harmless elsewhere, so they are always sent.
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
        // A 200 with no text is the reasoning-model shape arriving differently than
        // expected, or an empty completion. Worth one more try, then give up.
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
        // A smaller body is worth trying on this one, so move to the next attempt.
        lastRefusal = await failureReason(res);
        break;
      }

      // A terminal status ends the call now: retrying or shrinking the request would
      // spend the caller's quota to arrive at the same answer, and on a per-day free
      // tier that quota is the thing being protected.
      if (TERMINAL.has(res.status)) {
        const reason = await failureReason(res);
        throw new OpenAiCompatibleError(reason, { status: res.status });
      }

      throw new OpenAiCompatibleError(`LLM returned ${await failureReason(res)}`, { status: res.status });
    }
  }

  // Prefer reporting the refusal: it is the actionable one. A provider that is merely
  // busy has already been retried three times.
  if (lastRefusal) throw new OpenAiCompatibleError(lastRefusal);
  throw new OpenAiCompatibleError(
    lastUnavailable ? `the provider was unavailable — ${lastUnavailable}` : 'no attempt succeeded',
  );
}