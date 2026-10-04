/**
 * OpenAI-compatible transport for the narration layer.
 *
 * One code path serves OpenAI, Groq, OpenRouter, Together, DeepSeek, Mistral, xAI,
 * Cerebras and local Ollama, because they all implement the same Chat Completions
 * shape. The only thing that varies is which optional fields a given server
 * accepts, and that is handled by the attempt ladder rather than by asking users
 * to find a provider that happens to accept all of them.
 */

const TEMPERATURE = 0.4;
const MAX_TOKENS = 1400;
const TIMEOUT_MS = 90_000;

export class OpenAiCompatibleError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'OpenAiCompatibleError';
    this.status = status;
  }
}

/**
 * Attempt ladder, fullest request first. Each entry is a subset of the previous.
 *
 * `response_format: json_object` is an OpenAI extension that plenty of
 * OpenAI-compatible servers do not implement, and `max_tokens` was renamed to
 * `max_completion_tokens` for OpenAI's reasoning models. Rather than force every
 * user to find a provider that accepts both, the call degrades instead of
 * failing. This ladder is asserted by `test/llm.test.js` against a mock provider.
 */
function attempts({ model, system, user }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return [
    { model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, response_format: { type: 'json_object' }, messages },
    { model, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages },
    { model, temperature: TEMPERATURE, max_completion_tokens: MAX_TOKENS, messages },
    { model, messages },
  ];
}

/** The Chat Completions reply is the one shape worth reading directly. */
export function extractText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // Some gateways return content as an array of typed parts.
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

async function failureReason(res) {
  let detail = '';
  try {
    const raw = await res.text();
    detail = raw ? String(JSON.parse(raw)?.error?.message || raw).slice(0, 300) : '';
  } catch {
    detail = '';
  }
  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

/**
 * @param {{ system: string, user: string }} prompt
 * @param {ReturnType<import('./llm-provider.js').resolveLlm>} config
 * @returns {Promise<string>}
 * @throws {OpenAiCompatibleError}
 */
export async function callOpenAiCompatible(prompt, config) {
  const url = config.endpoint || `${config.baseUrl}/chat/completions`;
  const bodies = attempts({ model: config.model, system: prompt.system, user: prompt.user });

  let last = null;

  for (const body of bodies) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) {
      return extractText(await res.json());
    }

    last = await failureReason(res);
  }

  throw new OpenAiCompatibleError(`LLM returned ${last}`);
}