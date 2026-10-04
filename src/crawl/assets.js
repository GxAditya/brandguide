/**
 * Asset verification.
 *
 * A logo URL scraped out of markup is a guess. Before BrandKit hands a marketer
 * a link to drop into a deck, it asks TinyFish Fetch to read that URL. A real
 * logo returns extractable content; a dead path returns `empty_content` or
 * `page_not_found`. Only verified assets are returned, and each carries the
 * evidence for why it was kept.
 */

/**
 * @typedef {object} AssetCandidate
 * @property {string} url
 * @property {string} kind  logo | icon | social | touch-icon | manifest
 * @property {number} score
 * @property {string} reason
 */

/**
 * Verify a batch of asset URLs through TinyFish Fetch.
 *
 * Assets are verified in batched calls (up to 10 at a time).
 *
 * How existence is proven, and why it is honest: TinyFish Fetch renders the URL
 * in a browser and extracts text. A real image has no text, so it comes back as
 * `empty_content`, which means the URL resolved and rendered. A missing file
 * comes back as `page_not_found` (HTTP 404), and a bad host as `invalid_url` or
 * `target_unreachable`. For asset URLs the *absence* of extracted text is the
 * proof of existence, and the error code is what separates "there is an image
 * here" from "there is nothing here".
 *
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {AssetCandidate[]} candidates
 * @returns {Promise<{ verified: object[], rejected: object[] }>}
 */
export async function verifyAssets(client, candidates) {
  const list = (candidates || []).filter((c) => c.url);
  if (!list.length) return { verified: [], rejected: [] };

  const { results, errors } = await client.fetchContent(list.map((c) => c.url), {
    format: 'json',
    perUrlTimeoutMs: 30_000,
    purpose:
      'Verify that a candidate brand asset URL resolves to a real file on the live site before including it in a brand guide.',
    label: `assets × ${Math.min(list.length, 10)}`,
  });

  const resolved = new Set();
  for (const r of results) {
    resolved.add(r.url);
    if (r.final_url) resolved.add(r.final_url);
  }

  // `empty_content` on an image-shaped URL means: resolved, rendered, no text.
  const renderedAsBinary = new Set(
    errors.filter((e) => e.error === 'empty_content').map((e) => e.url),
  );

  const verified = [];
  const rejected = [];

  for (const candidate of list) {
    const isBinary = renderedAsBinary.has(candidate.url);
    const isResolved = resolved.has(candidate.url);

    if (isBinary || isResolved) {
      verified.push({
        ...candidate,
        verified: true,
        verifiedBy: 'tinyfish-fetch',
        evidence: isBinary
          ? 'fetch rendered the URL and found no text, which is what a real image returns'
          : 'fetch resolved and returned a document',
      });
      continue;
    }

    const err = errors.find((e) => e.url === candidate.url);
    rejected.push({
      ...candidate,
      verified: false,
      reason: err?.error || 'fetch did not resolve this URL',
    });
  }

  return { verified, rejected };
}

/** Probe conventional icon paths on a domain, for sites with a sparse <head>. */
export function conventionalIconUrls(baseUrl) {
  const root = baseUrl.replace(/\/+$/, '');
  return [
    { url: `${root}/favicon.ico`, kind: 'icon', score: 30, reason: 'conventional favicon path' },
    { url: `${root}/apple-touch-icon.png`, kind: 'touch-icon', score: 34, reason: 'conventional Apple touch icon path' },
    { url: `${root}/apple-touch-icon-precomposed.png`, kind: 'touch-icon', score: 28, reason: 'conventional Apple touch icon path' },
  ];
}