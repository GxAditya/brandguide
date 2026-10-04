/**
 * Endpoint 3 — voice and messaging lab.
 *
 * Goes deeper into copy than the kit does. Where /brand-guide reads a handful of
 * pages to describe the brand, this crawls deliberately for *prose*: about,
 * careers, blog, press, manifesto. Careers and blog posts are where a brand's
 * real voice lives — the homepage is where it is edited.
 *
 * Output: a tone vector, per-page consistency, do/don't guidance populated with
 * sentences quoted from the site, boilerplate separated from distinctive copy,
 * and message pillars with source URLs.
 */

import { collect } from './collect.js';
import { analyseCopy, mergeVoice, describeVoice } from '../extract/voice.js';
import { extractMessaging } from '../extract/messaging.js';
import { narrate, llmInfo } from './llm.js';

/** Pages worth reading for prose, in the order a strategist would read them. */
const PROSE_INTENTS = ['about', 'careers', 'press', 'customers', 'product', 'blog', 'pricing', 'page'];

const MIN_SENTENCES_PER_PAGE = 4;

/**
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} url
 * @param {{ depth?: string, onProgress?: Function, narrate?: boolean }} [opts]
 */
export async function buildVoiceReport(client, url, opts = {}) {
  // `deep` because prose pages are the entire point of this endpoint.
  const crawl = await collect(client, url, { ...opts, depth: opts.depth || 'deep' });

  // Prefer pages whose path signals prose, then fall back to whatever was read.
  const prosePages = crawl.readablePages
    .filter((p) => !p.error)
    .sort((a, b) => intentRank(a) - intentRank(b));

  const analyses = prosePages.map((p) => analyseCopy(p.html, p.url));
  const voice = mergeVoice(analyses);
  const messaging = extractMessaging(crawl.pages, crawl.head || {});

  const thin = analyses.filter((a) => a.ok && a.sentenceCount < MIN_SENTENCES_PER_PAGE);
  const solid = analyses.filter((a) => a.ok && a.sentenceCount >= MIN_SENTENCES_PER_PAGE);

  const outliers = findVoiceOutliers(solid, voice.vector);
  const boilerplate = findBoilerplate(messaging, analyses);

  let narrative = null;
  let narrativeMeta = { used: false, reason: 'not requested' };
  if (opts.narrate !== false) {
    const result = await narrate({
      identity: { name: new URL(crawl.url).hostname.replace(/^www\./, ''), domain: crawl.url },
      voice,
      messaging,
      colors: { tokens: [] },
      typography: { families: [] },
    });
    narrative = result.narrative;
    narrativeMeta = result.meta;
  }

  return {
    schemaVersion: '1.0.0',
    kind: 'voice',
    generatedAt: new Date().toISOString(),
    url: crawl.url,

    voice: {
      ...voice,
      summary: voice.ok
        ? buildSummary(voice)
        : 'No analysable prose was found on the pages that were read.',
      descriptors: voice.ok ? describeVoice(voice.vector) : [],
    },

    consistency: {
      ...(voice.consistency || { score: 0, grade: 'unknown', note: 'Not enough pages to measure.' }),
      outliers,
    },

    guidance: buildGuidance(voice, messaging),

    messaging: {
      positioning: messaging.positioning,
      pillars: messaging.pillars,
      headlines: messaging.headlines,
      keywords: messaging.keywords.slice(0, 16),
      claims: messaging.claims,
      taglines: messaging.taglines,
      boilerplate,
    },

    corpus: {
      pagesAnalysed: analyses.length,
      pagesWithProse: solid.length,
      pagesTooThin: thin.length,
      sentencesAnalysed: voice.sentencesAnalysed || 0,
      wordsAnalysed: voice.wordsAnalysed || 0,
      pages: prosePages.map((p) => {
        const a = analyses.find((x) => x.url === p.url);
        return {
          url: p.url,
          intent: p.intent || 'homepage',
          reason: p.reason || 'the site root',
          sentences: a?.sentenceCount ?? 0,
          words: a?.wordCount ?? 0,
          avgSentenceLength: a?.metrics?.avgSentenceLength ?? null,
          readingGrade: a?.metrics?.readingGrade ?? null,
          usable: (a?.sentenceCount ?? 0) >= MIN_SENTENCES_PER_PAGE,
        };
      }),
    },

    ...(narrative ? { narrative } : {}),
    narrativeMeta,
    llm: llmInfo(),
    provenance: {
      pagesRead: crawl.readablePages.length,
      pages: crawl.readablePages.map((p) => p.url),
      methods: [
        'TinyFish Fetch read each page as cleaned semantic HTML',
        'sentences were segmented, then measured for length, reading grade, pronoun address, hedging, contractions and register',
        'every do/don\'t rule is generated from the measurement and quotes a real sentence from the site',
      ],
    },
    warnings: [
      ...crawl.warnings,
      ...(thin.length
        ? [`${thin.length} page(s) had too little prose to analyse: ${thin.slice(0, 3).map((t) => t.url).join(', ')}`]
        : []),
    ],
  };
}

function intentRank(page) {
  const index = PROSE_INTENTS.indexOf(page.intent || 'page');
  return index === -1 ? PROSE_INTENTS.length : index;
}

/** A plain-language summary written from the measurements, not from opinion. */
function buildSummary(voice) {
  const v = voice.vector;
  const r = voice.raw;

  const parts = [];

  parts.push(
    `Across ${voice.pagesAnalysed} pages and ${voice.sentencesAnalysed} sentences, this brand writes in ${r.avgSentenceLength}-word sentences at roughly a grade ${Math.round(r.readingGrade)} reading level.`,
  );

  if (v.warmth > 0.55) parts.push('It talks to the reader far more than it talks about itself.');
  else if (v.warmth < 0.25) parts.push('It talks about itself more than it talks to the reader.');
  else parts.push('It balances "we" and "you" about evenly.');

  if (v.assertiveness > 0.8) parts.push('Claims are stated flatly, with almost no hedging.');
  else if (v.assertiveness < 0.4) parts.push('Claims are heavily qualified, which reads as cautious or humble.');
  else parts.push('It hedges occasionally, which reads as considered rather than weak.');

  if (v.playfulness > 0.5) parts.push('There is a lot of casual register and asides.');
  else parts.push('The register is steady, without casual asides.');

  if (voice.consistency) {
    parts.push(voice.consistency.note);
  }

  return parts.join(' ');
}

/** Pages whose voice diverges from the brand average. */
function findVoiceOutliers(pages, vector) {
  if (pages.length < 2 || !vector) return [];

  return pages
    .map((page) => {
      const axes = Object.keys(vector);
      let distance = 0;
      for (const axis of axes) {
        distance += Math.abs((page.metrics[axis] ?? 0) - vector[axis]);
      }
      distance /= axes.length;
      return { url: page.url, distance: Number(distance.toFixed(3)) };
    })
    .sort((a, b) => b.distance - a.distance)
    .slice(0, 3)
    .map((page) => ({
      ...page,
      note:
        page.distance > 0.25
          ? 'This page writes noticeably differently from the rest of the site — often a deliberate choice, such as a careers page being warmer than a product page.'
          : 'This page is close to the brand average.',
    }));
}

/** Nav and legal copy, kept out of the messaging analysis on purpose. */
function findBoilerplate(messaging, analyses) {
  const out = [];

  for (const heading of messaging.boilerplate || []) {
    out.push({ kind: 'heading', text: heading.text, source: heading.source });
  }

  // Copy that repeats across pages is boilerplate by definition.
  const seen = new Map();
  for (const analysis of analyses) {
    for (const sentence of analysis.signalSentences || []) {
      const key = sentence.text.toLowerCase().slice(0, 45);
      const entry = seen.get(key) || { kind: 'repeated sentence', text: sentence.text, pages: [] };
      entry.pages.push(analysis.url);
      seen.set(key, entry);
    }
  }

  for (const entry of seen.values()) {
    if (entry.pages.length >= 2) {
      out.push({
        kind: 'repeated sentence',
        text: entry.text,
        pages: entry.pages,
        note: 'Appears on more than one page — likely a standard strapline rather than page-specific voice.',
      });
    }
  }

  return out.slice(0, 12);
}

/** Merge the measured do/don't with the messaging findings. */
function buildGuidance(voice, messaging) {
  return {
    do: [...(voice.do || [])],
    dont: [...(voice.dont || [])],
    contentRules: buildContentRules(voice, messaging),
  };
}

function buildContentRules(voice, messaging) {
  const rules = [];

  const topTerms = (messaging.keywords || []).slice(0, 8).map((k) => k.term);
  if (topTerms.length) {
    rules.push({
      rule: `Use the brand's own vocabulary: ${topTerms.join(', ')}`,
      because: 'these are the terms that recur across the pages the brand publishes most, ranked by salience',
      evidence: (messaging.headlines || [])
        .filter((h) => topTerms.some((t) => h.text.toLowerCase().includes(t)))
        .slice(0, 2)
        .map((h) => ({ text: h.text, source: h.source })),
    });
  }

  const claims = (messaging.claims || []).slice(0, 3);
  if (claims.length) {
    rules.push({
      rule: 'Lead with a quantified claim when there is one to make',
      because: 'the brand already uses numeric proof in its own copy',
      evidence: claims.map((c) => ({ text: c.text, source: c.source })),
    });
  }

  if (messaging.positioning) {
    rules.push({
      rule: 'Keep the positioning sentence stable across channels',
      because: 'it is built from the brand\'s own description and headline',
      evidence: [{ text: messaging.positioning.text, source: messaging.positioning.source }],
    });
  }

  return rules;
}