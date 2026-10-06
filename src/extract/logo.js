/**
 * Logo extraction and verification.
 *
 * Candidates come from real signals (icon links, og:image, manifest icons,
 * conventional favicon paths), then each is read back through TinyFish Fetch: the
 * difference between handing a marketer a dead link and an asset they can drop in a
 * deck is the whole job.
 */

import { verifyAssets, conventionalIconUrls } from '../crawl/assets.js';
import { attachSvgSource } from './svg.js';

const FORMAT_HINTS = [
  { ext: '.svg', format: 'svg', bonus: 30, note: 'vector, scales to any size' },
  { ext: '.png', format: 'png', bonus: 0, note: 'raster' },
  { ext: '.ico', format: 'ico', bonus: -8, note: 'favicon only, small' },
  { ext: '.jpg', format: 'jpg', bonus: -6, note: 'raster photo' },
  { ext: '.jpeg', format: 'jpeg', bonus: -6, note: 'raster photo' },
  { ext: '.webp', format: 'webp', bonus: 4, note: 'raster' },
  { ext: '.gif', format: 'gif', bonus: -4, note: 'animated raster' },
];


export async function extractLogos({ head, manifest, pageUrl, pageImageLinks = [], client }) {
  const origin = assetOrigin(pageUrl);
  const candidates = [];

  // --- Manifest icons: the most deliberate statement of "this is my logo" ----
  for (const icon of manifest?.icons || []) {
    const w = parseInt((icon.sizes || '').split(' ')[0], 10) || 0;
    candidates.push({
      url: icon.url,
      kind: 'logo',
      score: 40 + Math.min(w, 512) / 12,
      reason: `declared in web app manifest${icon.sizes ? ` (${icon.sizes})` : ''}`,
      declaredSize: icon.sizes || null,
    });
  }

  // --- <link rel=icon> and apple-touch-icon --------------------------------
  for (const icon of head?.icons || []) {
    const rel = (icon.rel || '').toLowerCase();
    const hint = formatHint(icon.url);
    let score = 24 + hint.bonus;
    let reason = `<link rel="${icon.rel}">`;

    if (rel.includes('apple-touch-icon')) {
      score = 58;
      reason = 'Apple touch icon declared in the document head';
    } else if (icon.type === 'image/svg+xml' || /\.svg(\?|$)/i.test(icon.url)) {
      score = 82;
      reason = 'SVG icon declared in the document head, so it is vector and holds up in print';
    }
    if (icon.sizes && icon.sizes !== 'any') {
      const px = largestSquare(icon.sizes);
      if (px) score += Math.min(px, 512) / 10;
    }
    if (icon.url && origin && icon.url.startsWith(origin)) score += 6;

    candidates.push({ url: icon.url, kind: rel.includes('apple-touch') ? 'logo' : 'icon', score, reason, declaredSize: icon.sizes || null });
  }

  // --- og:image ------------------------------------------------------------
  if (head?.ogImage) {
    candidates.push({
      url: head.ogImage,
      kind: 'social',
      score: 30,
      reason: 'og:image social card, a rendered brand lockup rather than a bare mark',
    });
  }

  // --- Image URLs from the page body ---------------------------------------
  for (const url of pageImageLinks.slice(0, 60)) {
    if (!/\.(svg|png|webp|jpe?g|gif)(\?|$)/i.test(url)) continue;
    const hint = formatHint(url);
    const looksLikeLogo = /logo|wordmark|logotype|brandmark|brand[-_]?logo/i.test(url);
    if (!looksLikeLogo && hint.bonus < 20) continue;

    candidates.push({
      url,
      kind: 'logo',
      // Deliberately below head- and manifest-declared assets: a page image whose
      // *filename* says "logo" is often a campaign mark, which is how Patagonia's
      // one-percent-logo.svg outscored its actual brand assets.
      score: looksLikeLogo ? 48 + hint.bonus : 18,
      reason: looksLikeLogo
        ? 'page image with "logo" in its filename, weaker evidence than a declared icon'
        : 'SVG image on the page',
    });
  }

  // --- Conventional paths, for sites with a sparse head ---------------------
  for (const candidate of conventionalIconUrls(pageUrl)) {
    candidates.push({ ...candidate, score: candidate.score + 8, reason: `${candidate.reason} (lower confidence than a declared icon)` });
  }

  // --- Rank, dedupe, verify -------------------------------------------------
  const ranked = rankCandidates(candidates);
  const shortlist = ranked.slice(0, 10);
  const { verified, rejected } = await verifyAssets(client, shortlist);

  // Read the SVG source only for assets already proven to exist, so nothing is
  // fetched twice. Without this every `currentColor` logo renders as a flat
  // black shape, because an image cannot inherit from the page.
  const svgRead = await attachSvgSource(client, verified);

  const sorted = verified.sort((a, b) => b.score - a.score);
  const primary = sorted.find((c) => c.format === 'svg') || sorted.find((c) => c.kind === 'logo') || sorted[0] || null;

  // `primary` is SVG-first because a vector mark is what belongs on a swatch, but
  // the SVG in a document head is almost always the app icon — Tailwind's is a
  // dark rounded square, invisible on a dark plate and not the logo a reader
  // recognises. The lockup lives in the page body or the og:image, and that is
  // what a cover and a logotype page need.
  const lockup = findLockup(sorted) || primary;

  const enriched = sorted.map((c, index) => ({
    url: c.url,
    format: c.format,
    bytesHint: SIZE_HINTS[c.format] || null,
    reason: c.reason,
    declaredSize: c.declaredSize || null,
    origin: assetOrigin(c.url),
    firstParty: assetOrigin(c.url) === origin,
    rank: index + 1,
    verifiedBy: 'tinyfish-fetch',
    // Present only when the source was readable and safe to inline.
    svg: c.svg || null,
    svgTone: c.svgTone || null,
  }));

  const alternates = enriched
    .filter((a) => a.url !== primary?.url)
    .filter((a) => a.format !== primary?.format || a.origin !== primary?.origin)
    .slice(0, 5);

  return {
    primary: primary ? describeLogo(primary, origin) : null,
    // Null when it is the same asset, so a consumer can tell "no lockup found"
    // apart from "the lockup happens to be the mark".
    lockup: lockup && lockup !== primary ? describeLogo(lockup, origin) : null,
    alternates,
    rejected: rejected.slice(0, 4).map((r) => ({ url: r.url, reason: r.reason })),
    source: {
      method: 'candidates collected from head metadata, web app manifest and page images, then each one read back through TinyFish Fetch to confirm it resolves',
      candidates: ranked.length,
      verified: verified.length,
      rejected: rejected.length,
      svgInlined: svgRead.inlined,
    },
    confidence: verified.length
      ? Number(Math.min(0.95, 0.5 + (primary?.score ?? 0) / 200 + verified.length * 0.03).toFixed(2))
      : 0,
  };
}

/** Filenames that usually mean a horizontal logo rather than an icon. */
const LOCKUP_NAME = /logo|wordmark|logotype|brandmark|brand[-_]?logo|header[-_]?logo/i;

/**
 * The verified asset most likely to be the full logo, by signal strength: aspect
 * ratio of 2.2 or wider, then a filename that says so, then the social card, which
 * is by construction a rendered lockup.
 */
export function findLockup(sorted) {
  const described = sorted.map((c) => ({ candidate: c, described: describeLogo(c, '') }));

  const byRatio = described.find(({ described: d }) => d.type.includes('lockup'));
  if (byRatio) return byRatio.candidate;

  const byName = described.find(({ candidate: c }) => LOCKUP_NAME.test(c.url));
  if (byName) return byName.candidate;

  const social = described.find(({ candidate: c }) => c.kind === 'social');
  return social ? social.candidate : null;
}

function describeLogo(candidate, pageOrigin) {
  const enriched = {
    url: candidate.url,
    format: candidate.format,
    reason: candidate.reason,
    origin: assetOrigin(candidate.url),
    firstParty: assetOrigin(candidate.url) === pageOrigin,
    verifiedBy: 'tinyfish-fetch',
    // Present only when the source was readable and safe to inline.
    svg: candidate.svg || null,
    svgTone: candidate.svgTone || null,
  };
  return {
    ...enriched,
    type: guessType(enriched),
    minifiedCss: `@media (min-aspect-ratio: ${Math.max(1, Math.round((enriched.pixelWidth || 300) / (enriched.pixelHeight || 100)))}/100) { .brand-logo { aspect-ratio: ${enriched.pixelWidth || 300}/${enriched.pixelHeight || 100} } }`,
  };
}

/** Best guess at mark-only vs horizontal lockup, from the declared size. */
function guessType(asset) {
  if (asset.declaredSize && asset.declaredSize !== 'any') {
    const [w, h] = asset.declaredSize.split('x').map((n) => parseInt(n, 10) || 0);
    if (w && h) {
      const ratio = w / h;
      if (ratio >= 2.2) return 'horizontal lockup';
      if (ratio <= 0.85) return 'stacked or mark-only';
      return 'square mark';
    }
  }
  if (asset.format === 'ico') return 'favicon mark';
  if (asset.kind === 'social') return 'social card';
  return 'unknown, check the source file';
}

function rankCandidates(candidates) {
  const byUrl = new Map();
  for (const c of candidates) {
    if (!c.url || !/^https?:/i.test(c.url)) continue;
    const clean = c.url.split('#')[0];
    const hint = formatHint(clean);
    const existing = byUrl.get(clean);
    const scored = { ...c, score: (c.score || 0) + hint.bonus, format: hint.format };

    if (existing) {
      existing.score = Math.max(existing.score, scored.score);
      existing.reasons = [...new Set([...(existing.reasons || [existing.reason]), c.reason])];
      existing.declaredSize = existing.declaredSize || c.declaredSize || null;
    } else {
      scored.reasons = [c.reason];
      byUrl.set(clean, scored);
    }
  }

  const out = [];
  for (const c of byUrl.values()) {
    c.reason = c.reasons.join('; ');
    const px = largestSquare(c.declaredSize);
    out.push({ ...c, pixelWidth: px || null, pixelHeight: px || null });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function formatHint(url) {
  const clean = String(url).split('?')[0].toLowerCase();
  const hint = FORMAT_HINTS.find((f) => clean.endsWith(f.ext)) || FORMAT_HINTS[1];
  return hint;
}

const SIZE_HINTS = {
  svg: 'resolution-independent',
  png: 'check source for pixel dimensions',
  ico: 'multi-size favicon',
  jpg: 'raster photo',
  jpeg: 'raster photo',
  webp: 'raster',
  gif: 'animated raster',
};

function largestSquare(sizes) {
  if (!sizes) return null;
  let max = 0;
  for (const m of sizes.matchAll(/(\d{2,4})x(\d{2,4})/g)) {
    max = Math.max(max, parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
  }
  return max || null;
}

function assetOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}