/**
 * Name -> domain, via TinyFish Search.
 *
 * Given "Vercel" we need the official website, not a listicle or a LinkedIn
 * profile. There is no hardcoded brand table here; candidates are ranked on
 * signals that are generic to any company.
 */

import { normaliseUrl } from './input.js';

const SUPPORT_PAGES = /\b(about|company|who[- ]we[- ]are|contact|home|welcome|official|products?|platform|solutions?|enterprise|pricing)\b/i;

const NON_CANONICAL = [
  /(^|\.)(www\.)?(m|mobile|en|mx|de|fr|jp|uk|us|ca|au|in|br|it|es|nl|se|no|fi|dk|pl|cz|at|ch|be|ie|za|sg|hk|tw|kr|nz)\./i,
  /(^|\.)(blog|docs?|help|support|status|careers?|jobs?|press|pr|news|community|forum|wiki|learn|studio|app|cdn|static|assets?|media|img|images|files|downloads?|account|login|shop|store|checkout|cart|account)\./i,
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|pdf|zip|mp4|webm)$/i,
  /\/(tag|tags|category|categories|author|authors|p|posts?|page|pages|search)\//i,
];

/**
 * Platforms that host a company's profile but are not its website.
 *
 * Searching "linear official website" reliably returns a LinkedIn company page
 * near the top. It is a page *about* the brand, not the brand, and it is also
 * the most likely result to be blocked by bot protection. This is generic
 * knowledge about the shape of the web, not a list of brands.
 */
const PROFILE_PLATFORMS = [
  /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com|pinterest\.com|reddit\.com)$/i,
  /(^|\.)(crunchbase\.com|g2\.com|capterra\.com|trustpilot\.com|glassdoor\.com|indeed\.com|zoominfo\.com|apollo\.io|clearbit\.com)$/i,
  /(^|\.)(wikipedia\.org|wikidata\.org|britannica\.com|fandom\.com)$/i,
  /(^|\.)(github\.com|gitlab\.com|npmjs\.com|pypi\.org|dockerr\.io|hub\.docker\.com)$/i,
  /(^|\.)(medium\.com|substack\.com|dev\.to|hashnode\.dev|blogspot\.com|wordpress\.com|wixsite\.com|weebly\.com|carrd\.co)$/i,
  /(^|\.)(producthunt\.com|angel\.co|betalist\.com|wellfound\.com|builtin\.com)$/i,
  /(^|\.)(amazon\.com|ebay\.com|yelp\.com|indeed\.com|yellowpages\.com|mapquest\.com)$/i,
  /(^|\.)(apple\.com|play\.google\.com|appspot\.com|vercel\.app|netlify\.app|herokuapp\.com|github\.io|notion\.site)$/i,
  /(^|\.)(wikipedia\.org|youtube\.com|docs\.google\.com|support\.google\.com)$/i,
];

/** Path shapes that mark a hosted profile rather than a company's own page. */
const PROFILE_PATHS = /\/(company|companies|org|organisation|profile|profiles|pages?|posts?|pub|user|users|showcase)\//i;

/**
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} name
 * @returns {Promise<{ url: string, resolvedBy: 'search', candidates: object[], reasoning: string }>}
 */
export async function resolveFromSearch(client, name) {
  const query = `${name} official website`;
  const response = await client.search(query, {
    purpose:
      'Find the official company website for a brand guide extraction, so the correct homepage can be read and its assets fetched.',
  });

  const candidates = rankCandidates(response?.results || [], name);

  if (!candidates.length) {
    throw new Error(
      `Could not find an official website for "${name}". Try passing the URL directly.`,
      { code: 'NO_DOMAIN_FOUND' },
    );
  }

  const best = candidates[0];
  return {
    url: best.url,
    resolvedBy: 'search',
    candidates: candidates.slice(0, 5).map(stripInternal),
    reasoning: best.reasoning,
  };
}

function rankCandidates(results, name) {
  const nameKey = name.toLowerCase().trim();
  const nameCompact = nameKey.replace(/[^a-z0-9]/g, '');

  const scored = [];
  for (const result of results) {
    let url;
    try {
      url = normaliseUrl(result.url);
    } catch {
      continue; // Not an http(s) address we are willing to open.
    }

    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // Scoring works on URL parts, never on the raw string. A search result
    // carrying `?srsltid=...` used to be scored as though the tracking
    // parameter were a path segment, which promoted a deep localised page over
    // the company's own homepage.
    const path = parsed.pathname.replace(/\/index\.html?$/i, '/');
    const barePath = path === '/' ? '' : path.replace(/^\/|\/$/g, '');

    const reasons = [];
    let score = 0;
    let rejected = false;

    // The brand name appearing in the hostname is the single strongest signal.
    const hostCompact = host.replace(/^www\d?\./, '').replace(/[^a-z0-9]/g, '');
    if (host.includes(nameKey) || hostCompact.includes(nameCompact)) {
      score += 50;
      reasons.push('hostname contains the brand name');
    } else if (nameCompact.length >= 4 && hostCompact.includes(nameCompact.slice(0, 5))) {
      score += 15;
      reasons.push('hostname loosely matches the brand name');
    }

    // The homepage of a domain beats any page within it, decisively.
    const depth = barePath ? barePath.split('/').filter(Boolean).length : 0;
    if (depth === 0) {
      score += 30;
      reasons.push('homepage of the domain');
    } else {
      score -= depth * 8;
      if (SUPPORT_PAGES.test(barePath)) {
        score += 10;
        reasons.push('a standard company page');
      }
      reasons.push(`${depth} path segment${depth === 1 ? '' : 's'} deep`);
    }

    // A result whose own title is the brand name is very likely the official site.
    const title = String(result.title || '').toLowerCase();
    const siteName = String(result.site_name || '').toLowerCase();
    if (title === nameKey || siteName === nameKey) {
      score += 18;
      reasons.push('the result title is exactly the brand name');
    }

    // Subdomains we never want to read a brand guide from.
    if (NON_CANONICAL.some((re) => re.test(host))) {
      score -= 45;
      reasons.push('localised or non-canonical subdomain');
    }

    // A subdomain is a department, not a company. Searching "patagonia" returns
    // `wornwear.patagonia.com` -- a resale line with its own dark palette --
    // above `patagonia.com` itself, purely because the string "patagonia"
    // appears in its hostname. The brand's main site is the registrable domain.
    const labels = host.replace(/^www\d?\./, '').split('.').filter(Boolean);
    if (labels.length > 2) {
      score -= 35;
      reasons.push('a subdomain, not the brand main site');
    }

    // A hosted profile is not the company's website. Reject it outright
    // rather than merely demoting it: a LinkedIn page will usually fail to
    // render for an anonymous crawler anyway.
    if (PROFILE_PLATFORMS.some((re) => re.test(host))) {
      rejected = true;
      reasons.push(`${host} hosts third-party profiles, not a brand site`);
    }
    if (PROFILE_PATHS.test(barePath)) {
      rejected = true;
      reasons.push('looks like a hosted profile page');
    }

    if (/\b(tag|tags|category|author|search|post|20\d\d|19\d\d)\b/.test(barePath.toLowerCase())) {
      score -= 25;
      reasons.push('looks like an article or archive URL');
    }

    if (result.position <= 3) {
      score += 8 - result.position;
      reasons.push(`search position ${result.position}`);
    }

    // Drop every query string from the URL we will actually crawl.
    const clean = `${parsed.origin}${parsed.pathname}`;

    scored.push({
      url: clean,
      host,
      score,
      rejected,
      title: result.title || null,
      snippet: result.snippet || null,
      reasoning: reasons.join('; ') || 'no strong signal',
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((c) => !c.rejected && c.score > 0);
}

/**
 * Candidates are returned with their score and reasoning intact: that is the
 * evidence for why one domain was preferred, and a reviewer should be able to
 * see the reasoning rather than trust it.
 */
function stripInternal(c) {
  return c;
}

/**
 * For the /compare endpoint: find the official sites of named competitors.
 *
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string[]} names
 */
export async function resolveMany(client, names) {
  const out = [];
  for (const name of names) {
    try {
      out.push({ name, ...(await resolveFromSearch(client, name)) });
    } catch (err) {
      out.push({ name, url: null, error: err.message, candidates: [] });
    }
  }
  return out;
}
/** Exposed so the ranking rules can be tested without hitting Search. */
export const rankCandidatesForTest = rankCandidates;
