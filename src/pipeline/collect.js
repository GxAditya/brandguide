// The shared crawl. Everything downstream needs a resolved URL, the head, the
// stylesheets, the manifest, and a page corpus, so it is gathered once here.
// Independent stages run concurrently.

import { classifyInput } from '../resolve/input.js';
import { resolveFromSearch } from '../resolve/domain.js';
import { fetchHead } from '../crawl/head.js';
import { fetchStylesheets } from '../crawl/css.js';
import { fetchManifest } from '../crawl/manifest.js';
import { fetchPage, selectPages } from '../crawl/pages.js';
import { explainError, isRequestLevel } from '../tinyfish/errors.js';

// Depth controls how many pages are read. Stylesheets are always read broadly: a
// framework site spreads one token set across 40+ files, so a small cap loses the palette.
export const DEPTHS = {
  quick: { pages: 0, sheets: 50 },
  standard: { pages: 5, sheets: 50 },
  deep: { pages: 10, sheets: 60 },
};

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

  // If a name resolved to a domain that cannot be read, because of a bot wall, a dead
  // host, or a parked domain, try the next candidate Search offered.
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

  const { pages } = crawl;

  if (pages.length === 1 && !crawl.head && pages[0]?.error) {
    throw noReadableContent(crawl.url, pages[0]);
  }

  return {
    input: { given: rawInput, kind: classified.kind, ...resolution },
    url: crawl.url,
    head: crawl.head,
    manifest: crawl.manifest,
    css: crawl.css,
    pages,
    readablePages: pages.filter((p) => p.ok),
    depth: depthKey,
    warnings,
  };
}

// Read one site: head, homepage, linked pages, then stylesheets and manifest.
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
        // Downstream needs the code to tell an auth failure from a crawler block.
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

// Builds the "we could not read this site" error without lying about why. A bad key
// and a bot wall look identical here: no pages, no head. Blaming the site sends
// people off to try other URLs when the real fault is an expired key.
function noReadableContent(url, page) {
  const causeCode = page.errorCode || null;
  const requestLevel = isRequestLevel(causeCode);

  let message;
  if (requestLevel) {
    // Nothing about this URL is implicated, so do not cite it.
    const detail = explainError(causeCode);
    message = `Could not start the crawl: ${detail} No site can be read until this is fixed.`;
  } else if (causeCode) {
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