/**
 * Input normalisation: turn whatever the caller typed into either a URL or a
 * company name to hand to TinyFish Search. No brand list, no TLD list, no
 * hardcoded domains — the only knowledge here is about URL *shape*.
 */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^fc00:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

const STRIPPED_SUFFIXES = [
  'official site', 'official website', 'homepage', 'home page', 'website', 'site',
];

/** Leading filler, so "the website for linear" resolves to "linear". */
const LEADING_FILLER = /^(?:the\s+)?(?:official\s+)?(?:website|site|webpage|homepage|home\s+page|url|link)\s*(?:for|of|at)?\s+/i;

export class InputError extends Error {
  constructor(message, { code = 'INVALID_INPUT' } = {}) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

const looksLikeUrl = (s) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^www\.[^\s]+$/i.test(s)) return true;

  const domainish =
    /^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(s) || /^[\w-]{2,}(?:\.[\w-]+)+\/\S+$/.test(s);
  if (!domainish) return false;

  // "GOV.UK", "IBM" and "NASA" are written in caps and are brand names, not
  // addresses. A real hostname always carries a lowercase letter.
  const hostPart = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  return /[a-z]/.test(hostPart);
};

/**
 * @returns {{ kind: 'url'|'name', url?: string, name?: string, original: string }}
 */
export function classifyInput(raw) {
  if (typeof raw !== 'string') throw new InputError('Input must be a string.');

  let value = raw.trim().replace(/\s+/g, ' ');
  if (!value) throw new InputError('Enter a URL or a company name.');
  if (value.length > 300) throw new InputError('That input is too long.');

  // Drop a leading @ so "@vercel" and "vercel" behave the same.
  if (value.startsWith('@') && !value.includes('/')) value = value.slice(1);

  // Strip conversational filler at both ends, so "the website for linear" and
  // "linear official site" both resolve to "linear".
  let changed = true;  while (changed) {
    changed = false;

    const leading = value.replace(LEADING_FILLER, '');
    if (leading !== value && leading.trim().length > 1) {
      value = leading.trim();
      changed = true;
    }

    for (const suffix of STRIPPED_SUFFIXES) {
      const next = value.replace(new RegExp(`\\s+(?:for\\s+)?${suffix}$`, 'i'), '');
      if (next !== value && next.trim().length > 1) {
        value = next.trim();
        changed = true;
      }
    }
  }

  if (!looksLikeUrl(value)) {
    return { kind: 'name', name: value, original: raw.trim() };
  }

  return { kind: 'url', url: normaliseUrl(value, raw.trim()), original: raw.trim() };
}

/**
 * Coerce a URL-ish string into an absolute http(s) URL with tracking params
 * removed. Rejects anything that is not a public web address.
 */
export function normaliseUrl(input, original = input) {
  let candidate = String(input).trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const scheme = candidate.slice(0, candidate.indexOf(':')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new InputError(
        `Only http and https URLs are supported (got "${scheme}://").`,
        { code: 'UNSUPPORTED_SCHEME' },
      );
    }
  } else {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new InputError(`"${original}" is not a URL we can open.`, { code: 'INVALID_URL' });
  }

  assertPublicHost(url.hostname, original);

  // Tracking parameters add nothing to a brand guide and break URL comparison.
  const TRACKING = /^(utm_|ref_?$|ref$|gclid$|fbclid$|mc_[ce]id$|igshid$|msclkid$|yclid$|_ga$|s_kwcid$|vero_id$|mkt_tok$)/i;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';

  // Collapse https://example.com/index.html -> https://example.com/
  if (/\/(index|default)\.html?$/i.test(url.pathname)) url.pathname = '/';

  return url.toString();
}

function assertPublicHost(hostname, original) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || (!host.includes('.') && host !== 'localhost')) {
    throw new InputError(`"${original}" does not look like a web address.`, { code: 'INVALID_HOST' });
  }
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new InputError(
        `"${original}" points at a private or local address, which is not allowed.`,
        { code: 'PRIVATE_ADDRESS' },
      );
    }
  }
}

/** Registrable-ish host: drops www and common subdomains, for grouping brands. */
export function rootHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch {
    return '';
  }
  const parts = host.split('.');
  const multi = /^(?:[^.]+\.)?(?:co|com|org|net|gov|edu|ac|or|ne)\.[a-z]{2}$/.test(host);
  if (multi) return parts.slice(-3).join('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

/** True when `url` is on the same registrable domain as `base`. */
export function sameSite(url, base) {
  return rootHost(url) === rootHost(base);
}