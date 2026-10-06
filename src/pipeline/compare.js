/**
 * The brand benchmark. Extracts the same vectors from two to five live brands and
 * diffs them: CIEDE2000 palette distance, font overlap, cosine distance between tone
 * vectors, and Jaccard overlap of message vocabulary.
 *
 * Not a leaderboard. A positioning read: which parts of this brand are its own, and
 * where it looks like everybody else.
 */

import { collect } from './collect.js';
import { resolveFromSearch } from '../resolve/domain.js';
import { classifyInput, rootHost } from '../resolve/input.js';
import { extractColors } from '../extract/color.js';
import { extractTypography } from '../extract/typography.js';
import { analyseCopy, mergeVoice } from '../extract/voice.js';
import { extractMessaging } from '../extract/messaging.js';
import { parseColor, deltaE2000, toHex } from '../lib/colour.js';
import { llmInfo } from './llm.js';

const MAX_BRANDS = 5;


export async function compareBrands(client, brand, competitors, opts = {}) {
  const names = [brand, ...competitors]
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .slice(0, MAX_BRANDS);

  if (names.length < 2) {
    const err = new Error('Provide a brand and at least one competitor to compare against.');
    err.code = 'NEEDS_TWO_BRANDS';
    throw err;
  }

  // Resolve every input to a domain first, so a typo fails fast before we spend a
  // minute of crawl budget on it.
  const resolved = [];
  for (const name of names) {
    try {
      const classified = classifyInput(name);
      const target =
        classified.kind === 'url'
          ? { url: classified.url, resolvedBy: 'direct', reasoning: 'input was a URL' }
          : await resolveFromSearch(client, classified.name);
      resolved.push({ name, ...target });
    } catch (err) {
      resolved.push({ name, url: null, error: err.message, resolvedBy: 'failed' });
    }
  }

  // Two brands on the same domain is a duplicate, not a comparison.
  const seen = new Set();
  const unique = resolved.filter((r) => {
    if (!r.url) return true;
    const host = rootHost(r.url);
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });

  const profiles = [];
  for (const entry of unique) {
    if (!entry.url) {
      profiles.push({ name: entry.name, url: null, error: entry.error, ok: false });
      continue;
    }
    try {
      profiles.push(await profileBrand(client, entry, opts));
    } catch (err) {
      profiles.push({
        name: entry.name,
        url: entry.url,
        ok: false,
        error: err.message,
      });
    }
  }

  const good = profiles.filter((p) => p.ok);
  const subject = good[0] || null;

  return {
    schemaVersion: '1.0.0',
    kind: 'compare',
    generatedAt: new Date().toISOString(),
    subject: subject?.name || names[0],
    brands: profiles.map(publicProfile),
    comparison: subject ? diffBrands(subject, good.slice(1)) : null,
    positioning: subject ? buildPositioning(subject, good) : null,
    llm: llmInfo(opts.creds),
    provenance: {
      resolvedVia: resolved.map((r) => ({
        name: r.name,
        url: r.url,
        method: r.resolvedBy,
        reasoning: r.reasoning,
      })),
      methods: [
        'TinyFish Search resolved each name to its official domain',
        'each brand then went through the same Fetch crawl, so the vectors are directly comparable',
        'palette distance uses CIEDE2000 in Lab space, which tracks what the eye sees rather than RGB distance',
        'voice distance is the cosine distance between normalised tone vectors',
      ],
    },
    warnings: [
      ...profiles.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`),
      ...(unique.length < names.length ? ['Two inputs resolved to the same domain and were de-duplicated.'] : []),
    ],
  };
}

/** The comparable subset of a brand. */
async function profileBrand(client, entry, opts) {
  const crawl = await collect(client, entry.url, { ...opts, depth: opts.depth || 'quick' });

  const colors = extractColors({ sheets: crawl.css.sheets, head: crawl.head || {}, manifest: crawl.manifest });
  const typography = extractTypography({ sheets: crawl.css.sheets, head: crawl.head || {} });
  const voice = mergeVoice(crawl.readablePages.map((p) => analyseCopy(p.html, p.url)));
  const messaging = extractMessaging(crawl.pages, crawl.head || {});

  return {
    ok: true,
    name: entry.name,
    url: crawl.url,
    domain: rootHost(crawl.url),
    resolvedBy: entry.resolvedBy,
    reasoning: entry.reasoning,

    palette: (colors.tokens || []).slice(0, 8).map((t) => ({ hex: t.hex, name: t.name, role: t.role })),
    roles: colors.roles,
    fonts: (typography.families || []).slice(0, 5).map((f) => ({
      family: f.family,
      kind: f.kind,
      role: f.role,
      webfont: f.isWebfont,
    })),
    toneVector: voice.vector,
    voiceStats: voice.raw,
    terms: (messaging.keywords || []).slice(0, 20).map((k) => k.term),
    headline: messaging.taglines?.[0]?.text || crawl.head?.ogDescription || null,

    // Private: used for the maths, stripped before serialising.
    _paletteRgb: (colors.tokens || []).map((t) => parseColor(t.hex)).filter(Boolean),
    _fontNames: (typography.families || []).map((f) => f.family.toLowerCase()),
  };
}

function publicProfile(profile) {
  const { _paletteRgb, _fontNames, ...rest } = profile;
  return {
    ...rest,
    fontsCount: rest.fonts?.length || 0,
    paletteCount: rest.palette?.length || 0,
  };
}

// --- the diff --------------------------------------------------------------

const TONE_AXES = ['directness', 'formality', 'enthusiasm', 'playfulness', 'warmth', 'assertiveness', 'confidence', 'technicality'];

function diffBrands(subject, others) {
  if (!others.length) return { note: 'No comparable brand was available to diff against.', rows: [] };

  const rows = others.map((other) => {
    const palette = paletteDistance(subject._paletteRgb, other._paletteRgb);
    const fonts = fontOverlap(subject._fontNames, other._fontNames);
    const tone = toneDistance(subject.toneVector, other.toneVector);
    const terms = termOverlap(subject.terms, other.terms);

    return {
      against: other.name,
      url: other.url,
      palette,
      fonts,
      tone,
      vocabulary: terms,
      distinctiveness: distinctivenessScore({ palette, fonts, tone, terms }),
    };
  });

  rows.sort((a, b) => b.distinctiveness.score - a.distinctiveness.score);

  return {
    note: 'Distinctiveness is 0-100. High means this brand reads as its own thing next to that competitor.',
    rows,
    mostDistinct: rows[0] ? { against: rows[0].against, score: rows[0].distinctiveness.score } : null,
    leastDistinct: rows.length > 1 ? { against: rows[rows.length - 1].against, score: rows[rows.length - 1].distinctiveness.score } : null,
  };
}

/** Averaged, with the closest pair reported: shared colour is the strongest signal of sameness. */
function paletteDistance(a, b) {
  if (!a.length || !b.length) return { average: null, closest: null, note: 'One brand had no readable palette.' };

  const perSubject = a.map((colour) => {
    let best = Infinity;
    let bestHex = null;
    for (const other of b) {
      const d = deltaE2000(colour, other);
      if (d < best) {
        best = d;
        bestHex = toHex(other);
      }
    }
    return { distance: best, to: bestHex };
  });

  const average = perSubject.reduce((s, x) => s + x.distance, 0) / perSubject.length;
  const closest = [...perSubject].sort((x, y) => x.distance - y.distance)[0];

  // CIEDE2000 under ~2.3 is imperceptible; ~1 is the same colour.
  const shared = perSubject.filter((x) => x.distance < 2.3).length;
  return {
    average: Number(average.toFixed(1)),
    closest: closest ? { distance: Number(closest.distance.toFixed(1)), to: closest.to } : null,
    imperceptiblyClose: shared,
    reading:
      average < 10 ? 'near-identical palettes'
        : average < 25 ? 'clearly related palettes'
          : average < 45 ? 'different palettes with some overlap'
            : 'unrelated palettes',
  };
}

function fontOverlap(a, b) {
  const setA = new Set(a);
  const shared = b.filter((f) => setA.has(f));
  const union = new Set([...a, ...b]);
  return {
    shared,
    jaccard: union.size ? Number((shared.length / union.size).toFixed(2)) : null,
    reading: shared.length
      ? `both use ${shared.join(' and ')}`
      : 'no shared typefaces',
  };
}

/** Cosine distance between two tone vectors, plus the axis that diverges most. */
function toneDistance(a, b) {
  if (!a || !b) return { distance: null, worstAxis: null, note: 'One brand had too little prose to measure.' };

  let dot = 0;
  let magA = 0;
  let magB = 0;
  let worstAxis = null;
  let worstDelta = -1;

  for (const axis of TONE_AXES) {
    const x = a[axis] ?? 0;
    const y = b[axis] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
    if (Math.abs(x - y) > worstDelta) {
      worstDelta = Math.abs(x - y);
      worstAxis = axis;
    }
  }

  const cosine = magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
  const distance = Number((1 - cosine).toFixed(3));

  return {
    distance,
    worstAxis,
    worstDelta: Number(Math.max(0, worstDelta).toFixed(3)),
    reading:
      distance < 0.08 ? 'nearly the same voice'
        : distance < 0.25 ? 'related voice with a different accent'
          : distance < 0.5 ? 'distinctly different voice'
            : 'completely different voice',
  };
}

function termOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const shared = [...setA].filter((t) => setB.has(t));
  const union = new Set([...a, ...b]);
  return {
    shared: shared.slice(0, 12),
    jaccard: union.size ? Number((shared.length / union.size).toFixed(2)) : null,
    onlySubject: [...setA].filter((t) => !setB.has(t)).slice(0, 12),
  };
}

/**
 * Blend the four distances into one 0-100 distinctiveness score.
 * Weights reflect which signals a viewer actually notices: colour and type
 * register before vocabulary.
 */
function distinctivenessScore({ palette, fonts, tone, terms }) {
  const parts = [];

  // The driver name rides on the part rather than being recovered from its
  // weight, so 'type' and 'voice' stay distinguishable.
  if (palette.average !== null) parts.push({ signal: 'palette', value: Math.min(100, palette.average * 2.2), weight: 0.4 });
  if (fonts.jaccard !== null) parts.push({ signal: 'type', value: (1 - fonts.jaccard) * 100, weight: 0.25 });
  if (tone.distance !== null) parts.push({ signal: 'voice', value: Math.min(100, tone.distance * 100), weight: 0.25 });
  if (terms.jaccard !== null) parts.push({ signal: 'vocabulary', value: (1 - terms.jaccard) * 100, weight: 0.1 });

  if (!parts.length) return { score: 0, band: 'unknown', drivers: [] };

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight);

  return {
    score,
    band: score > 70 ? 'highly distinctive' : score > 45 ? 'moderately distinctive' : 'blends in',
    drivers: parts
      .map((p) => ({ signal: p.signal, value: Math.round(p.value) }))
      .sort((a, b) => b.value - a.value),
  };
}

/** The narrative read across the set. */
function buildPositioning(subject, all) {
  if (all.length < 2) return null;

  const closest = all.slice(1).reduce((best, brand) => {
    const d = paletteDistance(subject._paletteRgb, brand._paletteRgb).average;
    return d !== null && (!best || d < best.distance) ? { brand, distance: d } : best;
  }, null);

  const terms = all.slice(1).flatMap((b) => b.terms);
  const termCounts = new Map();
  for (const term of terms) termCounts.set(term, (termCounts.get(term) || 0) + 1);
  const crowded = [...termCounts.entries()]
    .filter(([, n]) => n >= Math.ceil(all.length / 2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([term]) => term);

  const owned = subject.terms.filter((t) => !crowded.includes(t)).slice(0, 10);

  return {
    crowded: {
      terms: crowded,
      note: crowded.length
        ? 'Every competitor leans on these words too. Using them says nothing.'
        : 'No vocabulary overlap found between this brand and its competitors.',
    },
    owned: {
      terms: owned,
      note: owned.length
        ? 'These terms are this brand\'s own across this comparison set — the space to write in.'
        : 'This brand shares most of its vocabulary with the set. That is a positioning problem, not a writing one.',
    },
    nearestNeighbour: closest
      ? {
          brand: closest.brand.name,
          paletteDistance: closest.distance,
          note: 'Closest competitor by colour. Visual similarity is what a buyer notices first.',
        }
      : null,
  };
}