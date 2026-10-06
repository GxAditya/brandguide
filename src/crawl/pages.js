/**
 * Page corpus selection and reading.
 *
 * A brand guide needs more than a homepage: tone of voice lives in the careers
 * page and the blog, positioning lives in /about, proof lives in /customers.
 * This module picks which pages are worth reading and fetches them.
 *
 * Selection is by *path intent*, generic across sites — no per-brand lists.
 */

import { sameSite } from '../resolve/input.js';
import { explainError } from '../tinyfish/errors.js';

/**
 * Path segments that reliably carry specific brand information.
 * Order matters only for tie-breaking.
 */
const INTENTS = [
  { key: 'about', score: 30, re: /\babout|who-?we-?are|company|mission|our-story|manifesto|why-we-exist|values\b/i },
  { key: 'careers', score: 26, re: /\bcareers?|jobs?|join-us|work-with-us|life-at|people\b/i },
  { key: 'customers', score: 24, re: /\bcustomers?|case-?stud|stories|testimonials|success|results|case-?studies\b/i },
  { key: 'pricing', score: 20, re: /\bpricing|plans?|plans-and-pricing|packages|buy|purchase\b/i },
  { key: 'product', score: 12, re: /^(what-we-do|our-(products|services|platform)|(products|services|platform)(-\w+)?)$/i },
  { key: 'press', score: 16, re: /\bpress|news|media|room|brand|assets?|kit\b/i },
  { key: 'blog', score: 14, re: /\bblog|news|journal|insights|articles?|posts?\b/i },
];

/** Paths we never read — noise, auth walls, or transactions. */
const EXCLUDE = [
  /\/(log-?in|sign-?in|sign-?on|log-?on|register|sign-?up|auth|log-?out|password|passcode|account|checkout|cart|basket|payment|order|orders|subscription|billing|unsubscribe|apply|claim)\b/i,
  /\/(privacy|terms|legal|cookie|cookies|gdpr|imprint|disclaimer)\b/i,
  /\/(rss|feed|atom|sitemap|robots)\b/i,
  /\/(search\?|q=|page=\d|offset=|start=)/i,
  /\.(pdf|zip|docx?|xlsx?|pptx?|mp4|webm|mp3|wav|avi|mov)(\?|$)/i,
  /\/(download|downloads|release|releases)\b/i,
  /#[^/]*$/,
];

/**
 * Score and pick same-site pages worth reading.
 *
 * @param {string[]} links absolute URLs from the homepage
 * @returns {Array<{ url: string, intent: string, score: number, reason: string }>}
 */
export function selectPages(links, homepageUrl, opts = {}) {
  const limit = opts.limit ?? 7;
  const homePath = new URL(homepageUrl).pathname.replace(/\/$/, '') || '/';
  const seen = new Set([homepageUrl.replace(/\/$/, '')]);
  const picked = [];

  for (const link of links) {
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    url.hash = '';

    if (!/^https?:$/.test(url.protocol)) continue;
    if (!sameSite(url.toString(), homepageUrl)) continue;
    if (EXCLUDE.some((re) => re.test(url.pathname + url.search))) continue;

    // Normalise trailing slash so /about and /about/ are one page.
    const key = url.toString().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const path = url.pathname;
    if (path === homePath || path === '/') continue;
    // One level deep is usually a real page; deeper is usually an article.
    const depth = path.split('/').filter(Boolean).length;
    if (depth > 2) continue;

    const intent = INTENTS.find((i) => i.re.test(path));
    let score = intent ? intent.score : 6;
    let reason = intent ? `${intent.key} page` : 'site page';

    if (depth === 1) {
      score += 4;
      reason += ', top level';
    }
    if (/\/(blog|news|insights|journal|resources)\b/i.test(path)) {
      // A section index is more useful than an individual post.
      score -= 2;
      reason += ' (section index)';
    }

    picked.push({ url: url.toString(), intent: intent?.key || 'page', score, reason });
  }

  picked.sort((a, b) => b.score - a.score);

  // Keep the mix varied: at most two pages per intent, so we do not fetch five
  // blog indexes and learn nothing about the company.
  const perIntent = new Map();
  const out = [];
  for (const page of picked) {
    const n = perIntent.get(page.intent) || 0;
    if (n >= 2) continue;
    perIntent.set(page.intent, n + 1);
    out.push(page);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Read a page: cleaned semantic HTML plus absolute outbound links and images.
 *
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} url
 */
export async function fetchPage(client, url) {
  const { results, errors } = await client.fetchContent([url], {
    format: 'html',
    links: true,
    imageLinks: true,
    perUrlTimeoutMs: 45_000,
    purpose:
      'Read a live marketing page to extract brand identity signals: headings, product language, tone of voice and navigation.',
    label: `page · ${shortHost(url)}`,
  });

  const page = results[0];
  if (!page) {
    // A per-URL failure (bot wall, 404, timeout) is data, not an exception. Keep
    // both the raw code and a readable message so callers can branch on the code.
    const raw = errors[0];    const code = raw?.error || 'UNKNOWN';
    return {
      url: raw?.url || url,
      ok: false,
      error: explainError(code, raw || { url }),
      errorCode: code,
      html: '',
      text: '',
      links: [],
      imageLinks: [],
    };
  }

  return {
    url: page.final_url || url,
    ok: true,
    error: null,
    title: page.title || null,
    description: page.description || null,
    language: page.language || null,
    html: page.text || '',
    links: page.links || [],
    imageLinks: page.image_links || [],
    latencyMs: page.latency_ms ?? null,
  };
}

function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}