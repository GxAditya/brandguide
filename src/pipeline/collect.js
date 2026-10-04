/**
 * The shared crawl.
 *
 * Everything downstream needs the same five things: a resolved URL, the
 * document head, the stylesheets, the manifest, and a page corpus. This module
 * gathers them once so the four endpoints stay genuinely different in what they
 * *do with* the result, rather than re-fetching the same site four times.
 *
 * Stages that do not depend on each other run concurrently.
 */

import { classifyInput, normaliseUrl } from '../resolve/input.js';
import { resolveFromSearch } from '../resolve/domain.js';
import { fetchHead } from '../crawl/head.js';
import { fetchStylesheets } from '../crawl/css.js';
import { fetchManifest } from '../crawl/manifest.js';
import { fetchPage, selectPages } from '../crawl/pages.js';
import { explainError, isRequestLevel } from '../tinyfish/errors.js';

/**
 * Depth controls how many *pages* are read. Stylesheets are always read broadly:
 * a framework site routinely spreads one brand token set across 40+ files with
 * opaque build hashes, so a small cap silently loses the palette entirely.
 * Reading all of them costs a handful of batched Fetch calls and ~300KB.
 */
export const DEPTHS = {
  quick: { pages: 0, sheets: 50 },
  standard: { pages: 5, sheets: 50 },
  deep: { pages: 10, sheets: 60 },
};

/**
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} rawInput URL or company name
 * @param {{ depth?: 'quick'|'standard'|'deep', onProgress?: (e: object) => void }} [opts]
 */
export async function collect(client, rawInput, opts = {}) {
  const depthKey = DEPTHS[opts.depth] ? opts.depth : 'standard';
  const depth = DEPTHS[depthKey];
  const progress = opts.onProgress || (() => {});
  const warnings = [];

  // --- 1. Resolve the input -------------------------------------------------
  progress({ stage: 'resolve', status: 'start' });
  const classified = classifyInput(rawInput);
  const resolution =
    classified.kind === 'url'
      ? { url: classified.url, resolvedBy: 'direct', candidates: [], reasoning: 'input was already a URL' }
      : await resolveFromSearch(client, classified.name);
  progress({ stage: 'resolve', status: 'done', url: resolution.url });

  // --- 2. Head and homepage, both needed to plan the rest -------------------
  let crawl = await readSite(client, resolution.url, depth, progress, warnings);

  // If a name resolved to a domain that cannot be read — a bot wall, a dead
  // host, a parked domain — try the next candidate Search offered before
  // giving up. One unreadable pick should not fail the whole run.
  const alternatives = (resolution.candidates || [])
    .map((c) => c.url)
    .filter((url) => url && url !== crawl.url);

  for (const alternative of alternatives) {
    if (crawl.readablePages.length) break;
    const attempt = await readSite(client, alternative, depth, progress, warnings, { quiet: true });
    if (attempt.readablePages.length) {
      warnings.push(`${resolution.url} could not be read; used ${alternative} instead.`);
      crawl = attempt;
    }
  }

  const finalUrl = crawl.url;
  const head = crawl.head;
  const { pages } = crawl;

  if (pages.length === 1 && !head && pages[0]?.error) {
    throw noReadableContent(finalUrl, pages[0]);
  }

  // --- 4. Stylesheets and manifest, in parallel -----------------------------
  progress({ stage: 'assets', status: 'start' });
  const [css, manifest] = await Promise.all([
    head?.stylesheets?.length
      ? fetchStylesheets(client, head.stylesheets, { cap: depth.sheets }).catch((err) => {
          warnings.push(`Could not read stylesheets: ${err.message}`);
          return { sheets: [], totalBytes: 0, skipped: [] };
        })
      : Promise.resolve({ sheets: [], totalBytes: 0, skipped: [] }),
    fetchManifest(client, head?.manifestUrl || null, finalUrl).catch(() => null),
  ]);

  // Summarise stylesheet failures rather than emitting one warning per file.
  if (css.skipped?.length) {
    const reasons = countBy(css.skipped, (s) => s.reason);
    warnings.push(
      `${css.skipped.length} stylesheet(s) could not be read (${Object.entries(reasons)
        .map(([reason, n]) => `${n}× ${reason}`)
        .join(', ')})`,
    );
  }
  progress({
    stage: 'assets',
    status: 'done',
    sheets: css.sheets.length,
    bytes: css.totalBytes,
    manifest: Boolean(manifest),
  });

  return {
    input: { given: rawInput, kind: classified.kind, ...resolution },
    url: finalUrl,
    head,
    manifest,
    css,
    pages,
    readablePages: pages.filter((p) => p.ok),
    depth: depthKey,
    warnings,
  };
}

/**
 * Read one site: head, homepage, the pages it links to, then its stylesheets
 * and manifest. Never throws for a single page failing, so the caller can decide
 * whether the attempt succeeded.
 */
async function readSite(client, url, depth, progress, warnings, { quiet = false } = {}) {
  const announce = quiet ? () => {} : progress;

  announce({ stage: 'read', status: 'start' });

  const [headResult, homepage] = await Promise.all([
    fetchHead(client, url).catch((err) => {
      warnings.push(`Could not read the document head for ${url}: ${err.message}`);
      return null;
    }),
    fetchPage(client, url).catch((err) => {
      warnings.push(`Could not read ${url}: ${err.message}`);
      return {
        url,
        ok: false,
        error: err.message,
        // Keep the code: readSite flattens this to text, and collect() needs the
        // code to tell an auth failure apart from a site that blocks crawlers.
        errorCode: err.code || null,
        html: '',
        links: [],
        imageLinks: [],
      };
    }),
  ]);

  const finalUrl = headResult?.url || homepage.url || url;
  const head = headResult?.head || null;

  announce({ stage: 'read', status: 'done', pages: 1, stylesheets: head?.stylesheets.length || 0 });

  // --- Plan the corpus ------------------------------------------------------
  let pages = [homepage];
  if (depth.pages > 0 && homepage.ok) {
    const selected = selectPages(homepage.links || [], finalUrl, { limit: depth.pages });
    if (selected.length) {
      announce({ stage: 'crawl', status: 'start', pages: selected.length });
      const fetched = await Promise.all(
        selected.map(async (candidate) => {
          try {
            return {
              ...(await fetchPage(client, candidate.url)),
              intent: candidate.intent,
              reason: candidate.reason,
            };
          } catch (err) {
            return {
              url: candidate.url,
              ok: false,
              error: err.message,
              html: '',
              links: [],
              imageLinks: [],
              intent: candidate.intent,
            };
          }
        }),
      );
      pages = pages.concat(fetched);
      announce({ stage: 'crawl', status: 'done', pages: fetched.filter((p) => p.ok).length });
    }
  }

  // --- Stylesheets and manifest -------------------------------------------
  announce({ stage: 'assets', status: 'start' });
  const [css, manifest] = await Promise.all([
    head?.stylesheets?.length
      ? fetchStylesheets(client, head.stylesheets, { cap: depth.sheets }).catch((err) => {
          warnings.push(`Could not read stylesheets for ${url}: ${err.message}`);
          return { sheets: [], totalBytes: 0, skipped: [] };
        })
      : Promise.resolve({ sheets: [], totalBytes: 0, skipped: [] }),
    fetchManifest(client, head?.manifestUrl || null, finalUrl).catch(() => null),
  ]);

  if (css.skipped?.length && !quiet) {
    const reasons = countBy(css.skipped, (s) => s.reason);
    warnings.push(
      `${css.skipped.length} stylesheet(s) on ${finalUrl} could not be read (${Object.entries(reasons)
        .map(([reason, n]) => `${n}× ${reason}`)
        .join(', ')})`,
    );
  }

  announce({
    stage: 'assets',
    status: 'done',
    sheets: css.sheets.length,
    bytes: css.totalBytes,
    manifest: Boolean(manifest),
  });

  return {
    url: finalUrl,
    head,
    manifest,
    css,
    pages,
    readablePages: pages.filter((p) => p.ok),
  };
}

/** Resolve without crawling — used by /compare for fast domain checks. */
export async function resolveOnly(client, rawInput) {
  const classified = classifyInput(rawInput);
  if (classified.kind === 'url') return normaliseUrl(classified.url);
  const resolved = await resolveFromSearch(client, classified.name);
  return resolved.url;
}

/**
 * Build the "we could not read this site" error without lying about why.
 *
 * The tempting single message here is "this site may block automated visitors",
 * and it was what shipped. But a bad API key and a bot wall look identical at
 * this point in the pipeline: both leave us with zero pages and no head. Blaming
 * the site sent people off to try different URLs while the real fault was an
 * expired key. So the underlying per-URL code decides the code and the wording.
 *
 * @param {string} url
 * @param {{ error?: string, errorCode?: string }} page the homepage that failed
 * @param {string[]} warnings
 */
function noReadableContent(url, page) {
  const causeCode = page.errorCode || null;
  const requestLevel = isRequestLevel(causeCode);

  let message;
  if (requestLevel) {
    // Nothing about this URL is implicated, so do not cite it.
    const detail = explainError(causeCode);
    message = `Could not start the crawl: ${detail} No site can be read until this is fixed.`;
  } else if (causeCode) {
    // TinyFish told us why, so say that rather than guessing at a bot wall.
    message = `Could not read any content from ${url}: ${explainError(causeCode, { url })}`;
  } else {
    message = `Could not read any content from ${url}. If this site blocks automated visitors, try a different URL.`;
  }

  const failure = new Error(message);
  failure.code = requestLevel ? causeCode : 'NO_READABLE_CONTENT';
  failure.url = url;
  if (causeCode) failure.cause = causeCode;
  return failure;
}

function countBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}