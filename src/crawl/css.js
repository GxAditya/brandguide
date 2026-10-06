/**
 * Stylesheet reading.
 *
 * Fetch returns a .css URL as raw text, so real colour and type declarations come
 * through the same channel as everything else. Coverage is the hard part: a framework
 * site may declare 40+ stylesheets with opaque build hashes, so we read broadly
 * rather than guess which one holds the tokens.
 */

const MAX_BYTES_PER_SHEET = 2_000_000;

/** Filenames that usually hold the global token set, by convention across frameworks. */
const GLOBAL_HINTS = /(global|globals|theme|tokens|vars|variables|custom-props|palette|main|index|app|styles|tailwind|base|root|primitives|design-system)/i;

const VENDOR_HINTS = /(^|\/)(vendor|node_modules|bootstrap|foundation|bulma|preflight|normalize|modernizr|polyfill|animate|swiper|slick|owl)[-./]/i;

/** Frameworks whose utility classes are noise for brand extraction. */
const UTILITY_ONLY = /(tailwind|bootstrap|bulma|foundation|animate|swiper|slick|owlcarousel|lodash)/i;

/**
 * Rank stylesheet URLs so the most likely token carriers are fetched first; `cap`
 * then decides how far down the list we get.
 */
export function prioritiseStylesheets(urls) {
  return (urls || [])
    .filter((url) => /\.(css)(\?|$)/i.test(url) || !/\.[a-z0-9]{2,5}(\?|$)/i.test(url))
    .map((url, index) => {
      const path = url.split('?')[0];
      let score = 0;
      if (GLOBAL_HINTS.test(path)) score += 40;
      if (VENDOR_HINTS.test(path)) score -= 30;
      if (UTILITY_ONLY.test(path)) score -= 18;
      // Framework build hashes look like `/pcGZUK31.css`; a readable name is a
      // weak signal that the file is hand-authored and brand-specific.
      if (/\/[a-z0-9_-]{6,10}\.[a-f0-9]{6}\.css$/i.test(path)) score -= 4;
      // Earlier in the <head> usually means more foundational.
      score += Math.max(0, 10 - index);      return { url, vendor: VENDOR_HINTS.test(path), utility: UTILITY_ONLY.test(path), score, index };
    })
    .sort((a, b) => b.score - a.score);
}


export async function fetchStylesheets(client, stylesheetUrls, opts = {}) {
  const cap = opts.cap ?? 24;
  const candidates = prioritiseStylesheets(stylesheetUrls);
  const chosen = candidates.slice(0, cap);
  const dropped = candidates.slice(cap);

  if (!chosen.length) return { sheets: [], totalBytes: 0, skipped: [], read: 0 };

  const { results, errors } = await client.fetchContent(chosen.map((c) => c.url), {
    format: 'markdown',
    perUrlTimeoutMs: 60_000,
    purpose:
      'Read the raw stylesheet text to extract the brand colour palette, CSS custom properties and font-face declarations.',
    label: `css × ${chosen.length}`,
  });

  const byUrl = new Map(chosen.map((c) => [c.url, c]));
  const sheets = [];
  let totalBytes = 0;

  for (const page of results) {
    const text = page.text || '';
    const url = page.final_url || page.url;
    if (!text.trim()) continue;
    if (text.length > MAX_BYTES_PER_SHEET) continue;

    totalBytes += text.length;
    sheets.push({
      url,
      css: text,
      bytes: text.length,
      vendor: byUrl.get(page.url)?.vendor ?? byUrl.get(url)?.vendor ?? false,
    });
  }

  // Only surface failures that are not simply "this one file was too big".
  const skipped = errors
    .filter((e) => e.error !== 'empty_content')
    .map((e) => ({ url: e.url, reason: e.error }));

  // A partial read must never be silent. Brand tokens and @font-face rules are
  // scattered across build-hashed files, so a missing third of them is the
  // difference between a full palette and no palette.
  const missing = chosen.length - new Set(sheets.map((s) => s.url)).size;  if (missing > 0) {
    skipped.push({ url: `${missing} stylesheet(s)`, reason: 'did not come back from fetch' });
  }

  return {
    sheets,
    totalBytes,
    skipped,
    read: sheets.length,
    requested: chosen.length,
    missing: Math.max(0, missing),
    dropped: dropped.length,
  };
}