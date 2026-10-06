/**
 * Asset verification. A logo URL scraped out of markup is a guess, so each is read
 * back through TinyFish Fetch before a marketer gets a link to drop into a deck.
 */

/**
 * Verify a batch of asset URLs through TinyFish Fetch.
 *
 * Fetch renders the URL and extracts text. A real image has no text, so it returns
 * `empty_content`, meaning the URL resolved and rendered; a missing file returns
 * `page_not_found`. The absence of text is the proof of existence, and the error code
 * separates "an image is here" from "nothing is here".
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
  const renderedAsBinary = new Set(    errors.filter((e) => e.error === 'empty_content').map((e) => e.url),
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