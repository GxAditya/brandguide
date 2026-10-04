/**
 * Friendly explanations for TinyFish per-URL error codes.
 * Used by the API error envelope and the UI so a failure reads as advice
 * rather than a stack trace.
 */
const MESSAGES = {
  target_http_error: 'The site returned an error status. It may be blocking automated requests.',
  page_not_found: 'That page does not exist (404).',
  target_unreachable: 'The site could not be reached — DNS, TLS, or the connection was refused.',
  timeout: 'The page took too long to load and the request timed out.',
  bot_blocked: 'The site is behind bot protection (Cloudflare, Incapsula) and served a challenge.',
  empty_content: 'The page loaded but no readable text was found. It may be a canvas-only or image-only page.',
  login_required: 'The page sits behind a login or account wall, so it cannot be read anonymously.',
  content_too_large: 'The document exceeds the 20MB size limit.',
  invalid_url: 'The URL was rejected as unsafe (private IP, invalid scheme, or disallowed host).',
  invalid_redirect_url: 'The site redirected to a URL that was rejected as unsafe.',
  proxy_error: 'The proxy tunnel failed. The site may still be reachable directly.',
  conditional_unsupported: 'That page needs full browser rendering, so conditional requests are not supported.',
  selector_not_matched: 'None of the CSS selectors matched anything on that page.',
  selector_unsupported: 'CSS selectors cannot be applied to this kind of document.',
  MISSING_API_KEY: 'TINYFISH_API_KEY is not configured.',
  INVALID_API_KEY:
    'TinyFish rejected the API key. Check TINYFISH_API_KEY — an expired key, or one left over from an earlier `export`, makes every site look unreadable.',
  NETWORK_ERROR: 'The request to TinyFish could not be completed.',
  UPSTREAM_TIMEOUT: 'The request to TinyFish timed out. Retry, or use a lighter depth.',
  HTTP_401: 'TinyFish rejected the API key (401). Check TINYFISH_API_KEY.',
  HTTP_403: 'TinyFish refused the API key (403). The key may lack access to this surface.',
  HTTP_429: 'TinyFish rate limit reached (429). Wait a moment and retry.',
};

/**
 * Request-level failures: our key or the connection is broken, so *no* site can
 * be read. These must never be reported as "this site blocks automated visitors",
 * which sends the user off to try a different URL when their key is the problem.
 *
 * Note `timeout` is deliberately absent: it is TinyFish's per-URL code and is a
 * genuine site attribute. Our own client aborts use UPSTREAM_TIMEOUT.
 */
const REQUEST_LEVEL = new Set([
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'HTTP_401',
  'HTTP_403',
  'HTTP_429',
  'NETWORK_ERROR',
  'UPSTREAM_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
]);

/** @param {string} code */
export function isRequestLevel(code) {
  return REQUEST_LEVEL.has(String(code || '').toUpperCase());
}

/**
 * @param {string} code
 * @param {{url?: string, status?: number, candidate_selectors?: string[]}} [info]
 */
export function explainError(code, info = {}) {
  const base = MESSAGES[code] || 'That URL could not be read.';
  const bits = [];
  if (info.url) bits.push(info.url);
  if (info.status) bits.push(`HTTP ${info.status}`);

  let out = base;
  if (bits.length) out += ` (${bits.join(' · ')})`;

  if (code === 'selector_not_matched' && info.candidate_selectors?.length) {
    out += ` Try selectors such as: ${info.candidate_selectors.slice(0, 4).join(', ')}.`;
  }
  return out;
}

/** Normalise a per-URL error entry from a Fetch response. */
export function normaliseFetchError(err) {
  return {
    url: err?.url ?? null,
    code: err?.error ?? 'UNKNOWN',
    status: err?.status ?? null,
    message: explainError(err?.error ?? 'UNKNOWN', err || {}),
  };
}