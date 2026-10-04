/**
 * Endpoint 1 — the full brand guide.
 *
 * Composes every extractor into the versioned guide object, then scores how
 * much to trust it. The confidence score is not decoration: it is derived from
 * how many independent sources agreed on each section, so a guide with a
 * missing stylesheet says so.
 */

import { collect } from './collect.js';
import { extractIdentity } from '../extract/identity.js';
import { extractColors } from '../extract/color.js';
import { extractTypography } from '../extract/typography.js';
import { extractLogos } from '../extract/logo.js';
import { extractMessaging } from '../extract/messaging.js';
import { analyseCopy, mergeVoice } from '../extract/voice.js';
import { narrate, llmInfo } from './llm.js';
import { DEFAULT_PAGES, clampPages } from '../lib/page-budget.js';

export const SCHEMA_VERSION = '1.0.0';

/**
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} input URL or company name
 * @param {{ depth?: string, pages?: number, onProgress?: Function, narrate?: boolean }} [opts]
 */
export async function buildBrandGuide(client, input, opts = {}) {
  const crawl = await collect(client, input, opts);

  const identity = extractIdentity({
    head: crawl.head,
    manifest: crawl.manifest,
    pages: crawl.readablePages,
    resolution: { url: crawl.url, resolvedBy: crawl.input.resolvedBy },
  });

  const [logos, colors, typography, messaging] = await Promise.all([
    extractLogos({
      client,
      head: crawl.head,
      manifest: crawl.manifest,
      pageUrl: crawl.url,
      pageImageLinks: crawl.pages.filter((p) => p.ok).flatMap((p) => p.imageLinks || []),
    }).catch((err) => {
      crawl.warnings.push(`Logo verification failed: ${err.message}`);
      return { primary: null, alternates: [], rejected: [], source: { method: 'verification aborted' }, confidence: 0 };
    }),

    Promise.resolve(extractColors({ sheets: crawl.css.sheets, head: crawl.head || {}, manifest: crawl.manifest })),

    Promise.resolve(extractTypography({ sheets: crawl.css.sheets, head: crawl.head || {} })),

    Promise.resolve(extractMessaging(crawl.pages, crawl.head || {})),
  ]);

  const pageAnalyses = crawl.readablePages.map((p) => analyseCopy(p.html, p.url));
  const voice = mergeVoice(pageAnalyses);

  const facts = { identity, colors, typography, voice, messaging };
  let narrative = null;
  let narrativeMeta = { used: false, reason: 'not requested' };

  if (opts.narrate !== false) {
    const result = await narrate(facts, { pages: opts.pages });
    narrative = result.narrative;
    narrativeMeta = result.meta;
  }

  const confidence = scoreConfidence({ crawl, logos, colors, typography, voice, messaging, identity });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    input: {
      given: input,
      kind: crawl.input.kind,
      resolvedUrl: crawl.url,
      resolvedBy: crawl.input.resolvedBy,
      reasoning: crawl.input.reasoning,
      candidates: crawl.input.candidates || [],
    },
    identity,
    logos,
    colors,
    typography,
    voice,
    messaging,
    ...(narrative ? { narrative } : {}),
    narrativeMeta,
    llm: llmInfo(),
    confidence,
    provenance: buildProvenance(client, crawl),
    deck: {
      requestedPages: clampPages(opts.pages),
      defaultPages: DEFAULT_PAGES,
    },
    warnings: crawl.warnings,
  };
}

/**
 * Per-section confidence, from how the section was derived rather than from a
 * fixed number.
 */
function scoreConfidence({ crawl, logos, colors, typography, voice, messaging, identity }) {
  const bySection = {};

  // Identity: did we get real metadata rather than a domain guess?
  bySection.identity = clamp01(
    (crawl.head ? 0.35 : 0) +
      (crawl.head?.ogTitle || crawl.head?.title ? 0.3 : 0) +
      (crawl.manifest?.name ? 0.2 : 0) +
      (identity.description ? 0.15 : 0),
  );

  // Logos: driven by verified assets and the strength of the winner.
  bySection.logos = clamp01(logos.confidence || 0);

  // Colour: stylesheets are the real source; head metadata is a fallback.
  const hasSheets = crawl.css.sheets.length > 0;
  const declaredTokens = colors.tokens.filter((t) => t.declared).length;
  bySection.colors = clamp01(
    (hasSheets ? 0.4 : 0) +
      Math.min(declaredTokens / 4, 1) * 0.35 +
      (crawl.head?.themeColor ? 0.15 : 0) +
      (crawl.manifest?.themeColor ? 0.1 : 0),
  );

  // Typography: @font-face declarations are unambiguous.
  const fontFaces = typography.families.filter((f) => f.declaredIn === '@font-face').length;
  bySection.typography = clamp01(
    (hasSheets ? 0.35 : 0) + Math.min(fontFaces / 3, 1) * 0.4 + (typography.families.length ? 0.25 : 0),
  );

  // Voice: needs prose, and more pages make it steadier.
  bySection.voice = voice.ok
    ? clamp01(
        Math.min(voice.sentencesAnalysed / 120, 1) * 0.6 + Math.min(voice.pagesAnalysed / 4, 1) * 0.4,
      )
    : 0;

  // Messaging: needs headings across more than one page.
  bySection.messaging = clamp01(
    Math.min(crawl.readablePages.length / 3, 1) * 0.5 + Math.min((messaging.headlines?.length || 0) / 10, 1) * 0.5,
  );

  const weights = { identity: 0.15, logos: 0.2, colors: 0.25, typography: 0.15, voice: 0.15, messaging: 0.1 };
  const overall = Object.entries(weights).reduce((sum, [key, w]) => sum + (bySection[key] || 0) * w, 0);

  return {
    overall: Number(overall.toFixed(2)),
    grade: overall > 0.75 ? 'high' : overall > 0.5 ? 'moderate' : 'low',
    bySection: Object.fromEntries(
      Object.entries(bySection).map(([k, v]) => [k, { score: Number(v.toFixed(2)), grade: v > 0.7 ? 'high' : v > 0.4 ? 'moderate' : 'low' }]),
    ),
    basis: 'derived from how many independent live sources contributed to each section, not a fixed value',
  };
}

/** Every TinyFish call that produced this guide, with timing. */
function buildProvenance(client, crawl) {
  return {
    tinyfish: {
      surfacesUsed: [...new Set(client.getCallLog().map((c) => c.surface))],
      calls: client.getCallLog().map((c) => ({
        id: c.id,
        surface: c.surface,
        label: c.label,
        okUrls: c.okUrls ?? null,
        errorCount: c.errorCount ?? null,
        durationMs: c.durationMs,
        format: c.meta?.format ?? null,
        includeSelectors: c.meta?.include_selectors ?? null,
        urls: c.meta?.urls ?? null,
        failed: Boolean(c.failed),
      })),
      totalCalls: client.getCallLog().length,
      totalMs: client.getCallLog().reduce((sum, c) => sum + (c.durationMs || 0), 0),
    },
    inputs: {
      resolvedFrom: crawl.input.resolvedBy,
      reasoning: crawl.input.reasoning,
      depth: crawl.depth,
    },
    pagesRead: crawl.readablePages.map((p) => ({
      url: p.url,
      intent: p.intent || 'homepage',
      reason: p.reason || 'the site root',
      title: p.title || null,
      latencyMs: p.latencyMs ?? null,
    })),
    stylesheetsRead: crawl.css.sheets.map((s) => ({ url: s.url, bytes: s.bytes, vendor: s.vendor })),
    manifest: crawl.manifest ? { url: crawl.manifest.url, themeColor: crawl.manifest.themeColor } : null,
    methods: [
      'TinyFish Search resolved the input to a domain when it was not a URL',
      'TinyFish Fetch read the document head via include_selectors=["head"], which returns og tags, theme-color, icon links and stylesheet URLs',
      'TinyFish Fetch read each stylesheet back as raw CSS text',
      'TinyFish Fetch read each marketing page as cleaned semantic HTML with links and image URLs',
      'TinyFish Fetch verified every candidate logo asset URL resolves before returning it',
    ],
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Number(n.toFixed(2))));
}