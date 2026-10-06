/**
 * TinyFish HTTP client — the only place in BrandKit that touches the network.
 *
 *   Search  GET  https://api.search.tinyfish.ai/    name -> domain, competitors
 *   Fetch   POST https://api.fetch.tinyfish.ai     pages, CSS, manifests, assets
 *
 * Both are free at any balance; the Browser and Agent surfaces are metered and
 * deliberately unused. A per-URL failure is data, never an exception; every call is
 * timed and recorded for the provenance panel; the API key is never logged.
 *
 * The key is the caller's, passed in per request. There is no environment fallback
 * and no default: a client with no key throws on its first call, which is the whole
 * point of a deployment that holds no secrets of its own.
 */

const FETCH_URL = process.env.TINYFISH_FETCH_URL || 'https://api.fetch.tinyfish.ai';
const SEARCH_URL = process.env.TINYFISH_SEARCH_URL || 'https://api.search.tinyfish.ai/';

/** TinyFish batches at most 10 URLs per Fetch call. */
const MAX_URLS_PER_CALL = 10;

/**
 * TinyFish has a 120s CDN ceiling on a batch and 110s per URL. Their docs tell
 * clients to use >= 150s so CDN timeouts arrive as clean errors instead of a
 * socket hangup on our side.
 */
const CLIENT_TIMEOUT_MS = 150_000;

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

export class TinyFishError extends Error {
  constructor(message, { code = 'TINYFISH_ERROR', status, requestId, detail } = {}) {
    super(message);
    this.name = 'TinyFishError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.detail = detail;
  }
}

export class TinyFishClient {
  /**
   * @param {{ apiKey?: string, fetchImpl?: typeof fetch, onCall?: (r: object) => void }} opts
   */
  constructor({ apiKey = '', fetchImpl, onCall } = {}) {
    this.apiKey = apiKey || '';
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.onCall = onCall || null;
    this.calls = [];
    this.callSeq = 0;
  }

  #record(entry) {
    const record = { id: `c${++this.callSeq}`, at: new Date().toISOString(), ...entry };
    this.calls.push(record);
    if (this.onCall) {
      try {
        this.onCall(record);
      } catch {
        /* a broken listener must never break a fetch */
      }
    }
    return record;
  }

  #headers() {
    if (!this.apiKey) {
      throw new TinyFishError(
        'No TinyFish API key. Open Settings in the header and add one, or send X-BrandKit-Tinyfish-Key.',
        { code: 'MISSING_API_KEY' },
      );
    }
    return {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * One HTTP round trip with retry and backoff. Returns the parsed body; the
   * timing is appended to the provenance log as a side effect.
   */
  async #request(url, init, { surface, label, meta }) {
    const started = Date.now();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
        clearTimeout(timer);

        if (RETRYABLE_HTTP.has(res.status) && attempt < 3) {
          await sleep(backoffMs(attempt, res.headers?.get?.('retry-after')));
          continue;
        }

        if (!res.ok) {
          const raw = await safeText(res);
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* non-JSON error body */
          }
          const apiErr = parsed?.error || {};
          throw new TinyFishError(
            apiErr.message || `TinyFish ${surface} returned HTTP ${res.status}`,
            {
              code: apiErr.code || `HTTP_${res.status}`,
              status: res.status,
              requestId: parsed?.request_id || res.headers?.get?.('x-request-id') || undefined,
              detail: apiErr.details,
            },
          );
        }

        const json = await res.json();
        this.#record({
          surface,
          label,
          meta,
          okUrls: Array.isArray(json?.results) ? json.results.length : undefined,
          errorCount: Array.isArray(json?.errors) ? json.errors.length : undefined,
          durationMs: Date.now() - started,
          attempts: attempt,
        });
        return json;
      } catch (err) {
        clearTimeout(timer);

        // Caller-side errors (bad input, 401, 422) will never succeed on retry.
        if (err instanceof TinyFishError && !RETRYABLE_HTTP.has(err.status)) throw err;        if (attempt >= 3) {
          this.#record({
            surface,
            label,
            meta,
            durationMs: Date.now() - started,
            attempts: attempt,
            failed: true,
            error: err?.message || String(err),
          });
          throw err instanceof TinyFishError
            ? err
            : new TinyFishError(`TinyFish ${surface} failed: ${err?.message || err}`, {
                code: err?.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR',
              });
        }
        await sleep(backoffMs(attempt));
      }
    }
  }

  /**
   * Search the web. Turns "Vercel" into a domain; finds competitor sites.
   *
   * @param {string} query
   * @param {object} [opts] Mirrors the TinyFish query parameters.
   */
  async search(query, opts = {}) {
    const params = new URLSearchParams({ query });
    for (const key of [
      'purpose', 'location', 'language', 'include_domains', 'exclude_domains',
      'domain_type', 'after_date', 'before_date', 'recency_minutes',
      'pub_year_min', 'pub_year_max', 'page', 'include_thumbnail',
    ]) {
      const value = opts[key];
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    if (opts.fetch) params.set('fetch', JSON.stringify(opts.fetch));

    return this.#request(
      `${SEARCH_URL}?${params.toString()}`,
      { method: 'GET', headers: this.#headers() },
      { surface: 'search', label: `search "${truncate(query, 60)}"`, meta: { query } },
    );
  }

  /**
   * Read one or more URLs through TinyFish Fetch. Always resolves: per-URL failures
   * come back in `errors`, and only a request-level failure throws.
   */
  async fetchContent(urls, opts = {}) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (!list.length) return { results: [], errors: [] };

    const chunks = chunk(list, MAX_URLS_PER_CALL);
    const base = {
      format: opts.format || 'markdown',
      links: Boolean(opts.links),
      image_links: Boolean(opts.imageLinks),
      per_url_timeout_ms: opts.perUrlTimeoutMs ?? 45_000,
    };
    if (opts.purpose) base.purpose = String(opts.purpose).slice(0, 2000);
    if (opts.ttl !== undefined) base.ttl = opts.ttl;
    if (opts.includeSelectors?.length) base.include_selectors = opts.includeSelectors;
    if (opts.excludeSelectors?.length) base.exclude_selectors = opts.excludeSelectors;

    const requestChunk = (c) =>
      this.#request(
        FETCH_URL,
        {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify({ ...base, urls: c }),
        },
        {
          surface: 'fetch',
          label: opts.label || `fetch ${c.length} url${c.length === 1 ? '' : 's'}`,
          meta: {
            format: base.format,
            links: base.links,
            image_links: base.image_links,
            include_selectors: base.include_selectors,
            exclude_selectors: base.exclude_selectors,
            urls: c,
          },
        },
      );

    // Batches run two at a time with a short gap: 49 stylesheets is five batches, and
    // firing them all at once trips the per-key rate limit.
    const concurrency = Math.max(1, opts.concurrency ?? 2);
    const staggerMs = opts.staggerMs ?? 120;
    const responses = [];

    for (let i = 0; i < chunks.length; i += concurrency) {
      const slice = chunks.slice(i, i + concurrency);
      responses.push(...(await Promise.all(slice.map(requestChunk))));
      if (i + concurrency < chunks.length && staggerMs) await sleep(staggerMs);
    }

    const merged = { results: [], errors: [] };
    for (const json of responses) {
      merged.results.push(...(json?.results || []));
      merged.errors.push(...(json?.errors || []));
    }
    return merged;
  }

  /** Provenance log, oldest first. Safe to return to clients. */
  getCallLog() {    return this.calls;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function backoffMs(attempt, retryAfterHeader) {
  const hinted = Number(retryAfterHeader);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 30_000);
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(value, n) {
  const str = String(value ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}