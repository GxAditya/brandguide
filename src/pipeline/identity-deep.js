/**
 * Endpoint 2 — visual forensics.
 *
 * Goes deeper into the stylesheet than the kit does. The brand guide answers
 * "what are the brand colours"; this answers "show me the token graph, the
 * contrast matrix, and give me something I can import into Figma".
 *
 * Output is shaped for tools, not for reading: Style Dictionary v3, `:root`
 * CSS, a Tailwind theme block, and a Figma Variables collection.
 */

import { collect } from './collect.js';
import { extractColors } from '../extract/color.js';
import { extractTypography } from '../extract/typography.js';
import { extractLogos } from '../extract/logo.js';
import {
  stripComments, parseCustomProperties, resolveCustomProperty, parseRadii, parseTypeDetail,
} from '../lib/css.js';
import { parseColor, contrastRatio, toHex } from '../lib/colour.js';
import { buildDesignTokens, toCss, toTailwind, toStyleDictionary, toFigmaVariables } from '../lib/tokens.js';
import { llmInfo } from './llm.js';

/**
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {string} url
 * @param {{ depth?: string, onProgress?: Function }} [opts]
 */
export async function buildIdentity(client, url, opts = {}) {
  const crawl = await collect(client, url, { ...opts, depth: opts.depth || 'deep' });

  const colors = extractColors({ sheets: crawl.css.sheets, head: crawl.head || {}, manifest: crawl.manifest });
  const typography = extractTypography({ sheets: crawl.css.sheets, head: crawl.head || {} });
  const logos = await extractLogos({
    client,
    head: crawl.head,
    manifest: crawl.manifest,
    pageUrl: crawl.url,
    pageImageLinks: crawl.pages.filter((p) => p.ok).flatMap((p) => p.imageLinks || []),
  }).catch(() => ({ primary: null, alternates: [], source: {}, confidence: 0 }));

  const combined = crawl.css.sheets.map((s) => stripComments(s.css)).join('\n');
  const tokenGraph = buildTokenGraph(crawl.css.sheets);
  const contrast = buildContrastPairs(colors);
  const shape = extractShape(combined);
  const typeSystem = buildTypeSystem(typography);

  const spacing = inferSpacing(combined);
  const designTokens = buildDesignTokens({ colors, typography, shape, spacing });

  return {
    schemaVersion: '1.0.0',
    kind: 'identity',
    generatedAt: new Date().toISOString(),
    url: crawl.url,
    domain: new URL(crawl.url).hostname,
    colours: colors,
    typography,
    logos,
    tokenGraph,
    contrast,
    shape,
    designTokens,
    exports: {
      css: toCss(designTokens, { url: crawl.url }),
      tailwind: toTailwind(designTokens),
      styleDictionary: toStyleDictionary(designTokens),
      figma: toFigmaVariables(designTokens),
    },
    llm: llmInfo(),
    provenance: {
      stylesheets: crawl.css.sheets.map((s) => ({ url: s.url, bytes: s.bytes })),
      read: crawl.css.sheets.length,
      declaredTokens: crawl.css.sheets.length,
      pagesRead: crawl.readablePages.map((p) => p.url),
      methods: [
        'TinyFish Fetch read every stylesheet named in the document head as raw CSS text',
        'custom properties were resolved through var() alias chains to their terminal values',
        'contrast pairs were computed with WCAG 2.1 relative luminance',
      ],
    },
    warnings: crawl.warnings,
  };
}

/**
 * Resolve every custom property to a terminal value and report how the
 * stylesheets reference each other. This is the part you cannot get from a
 * frequency count: it shows which tokens are aliases and which are the source.
 */
function buildTokenGraph(sheets) {
  const combined = sheets.map((s) => stripComments(s.css)).join('\n');
  const props = parseCustomProperties(combined);

  const resolved = [];
  const aliases = [];

  for (const name of props.keys()) {
    const terminal = resolveCustomProperty(props, name);
    if (!terminal) continue;
    const isAlias = /^var\(/i.test(terminal);
    const rgb = parseColor(terminal);

    const entry = {
      name,
      value: isAlias ? null : terminal,
      resolvesTo: isAlias ? terminal : null,
      isAlias,
      colour: rgb && rgb.a >= 1 ? toHex(rgb) : null,
      usedIn: (combined.match(new RegExp(`var\\(\\s*${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'g')) || []).length,
    };

    if (isAlias) aliases.push(entry);
    else resolved.push(entry);
  }

  return {
    total: props.size,
    // Tokens whose value is a literal: the actual source of truth.
    literalTokens: resolved.length,
    // Tokens that point at another token.
    aliasTokens: aliases.length,
    colours: resolved
      .filter((t) => t.colour)
      .sort((a, b) => b.usedIn - a.usedIn)
      .slice(0, 60),
    aliases: aliases.slice(0, 30),
    note: 'A token that many others point at is a load-bearing part of this brand system.',
  };
}

/** Every role pairing a designer would actually build, with a verdict. */
function buildContrastPairs(colors) {
  const r = colors.roles;
  const pairs = [
    ['text', 'background', 'body copy on the page'],
    ['text', 'surface', 'body copy on a card'],
    ['link', 'background', 'link text on the page'],
    ['muted', 'background', 'secondary text'],
    ['onPrimary', 'primary', 'button label'],
    ['primary', 'background', 'primary used as text'],
    ['onPrimary', 'accent', 'label on an accent button'],
    ['text', 'border', 'text against a hairline panel'],
    ['error', 'background', 'error text on the page'],
  ];

  const out = [];
  for (const [fgKey, bgKey, use] of pairs) {
    const fg = parseColor(r[fgKey]);
    const bg = parseColor(r[bgKey]);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    out.push({
      use,
      foregroundRole: fgKey,
      backgroundRole: bgKey,
      foreground: toHex(fg),
      background: toHex(bg),
      ratio,
      passesAA: ratio >= 4.5,
      passesAALarge: ratio >= 3,
      verdict:
        ratio >= 7 ? 'AAA — comfortable anywhere'
          : ratio >= 4.5 ? 'AA — fine for body text'
            : ratio >= 3 ? 'AA Large only — headings and large text'
              : 'Fails WCAG — raise the weight, size, or colour distance',
    });
  }
  return out;
}

/** Corner radius and border language. */
function extractShape(css) {
  const counts = parseRadii(css);
  const ranked = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const dominantPx = px(ranked[0]?.value) ?? null;

  return {
    radii: ranked.slice(0, 8),
    dominantRadius: ranked[0]?.value ?? null,
    character:
      dominantPx === null ? 'unknown'
        : dominantPx === 0 ? 'sharp — 0px corners, a precise, technical feel'
          : dominantPx <= 2 ? 'nearly sharp — 1-2px corners'
            : dominantPx <= 4 ? 'subtle — 3-4px corners, restrained'
              : dominantPx <= 8 ? 'friendly — 6-8px corners'
                : dominantPx <= 16 ? 'soft — rounded cards'
                  : 'very round — pill and bubble shapes',
    borders: {
      hairline: ranked.some((r) => px(r.value) === 1),
      thick: ranked.some((r) => (px(r.value) ?? 0) >= 3),
    },
  };
}

/** Turn a font-family list plus a scale into a usable type system. */
function buildTypeSystem(typography) {
  const heading = typography.pairing.heading;
  const body = typography.pairing.body;
  const mono = typography.pairing.mono;

  const ramp = [
    ['display', 3.5, 1.05, '-0.03em'],
    ['h1', 2.5, 1.1, '-0.02em'],
    ['h2', 2, 1.15, '-0.015em'],
    ['h3', 1.5, 1.2, '-0.01em'],
    ['h4', 1.25, 1.3, '0'],
    ['body', 1, 1.5, '0'],
    ['small', 0.875, 1.5, '0'],
    ['caption', 0.75, 1.4, '0.02em'],
  ];

  const detail = typography.detail || {};

  return {
    families: {
      heading: heading ? { family: heading, usage: 'headings and display type' } : null,
      body: body ? { family: body, usage: 'body copy and UI' } : null,
      mono: mono ? { family: mono, usage: 'code and technical detail' } : null,
    },
    scale: ramp.map(([name, rem, lh, tracking]) => ({
      name,
      size: `${rem}rem`,
      px: Math.round(rem * 16),
      lineHeight: lh,
      letterSpacing: tracking,
      font: name === 'body' || name === 'small' || name === 'caption' ? body : heading,
    })),
    observed: typography.scale?.slice(0, 8) || [],
    detail,
    note: typography.scale?.length
      ? 'Sizes marked "observed" appear in the live stylesheet; the rest are a conventional ramp built from them.'
      : 'No sizes were observed in the stylesheet, so this is a conventional ramp.',
  };
}

/** Spacing, inferred from the rem steps the CSS actually uses. */
function inferSpacing(css) {
  const steps = new Set();
  for (const m of css.matchAll(/(?:margin|padding|gap)\s*:\s*([^;{}]+)/gi)) {
    for (const v of m[1].matchAll(/(-?\d*\.?\d+)rem/gi)) {
      const n = Number.parseFloat(v[1]);
      if (Math.abs(n) > 0 && Math.abs(n) <= 8) steps.add(Number(n.toFixed(2)));
    }
  }
  const sorted = [...steps].sort((a, b) => a - b).slice(0, 12);
  return {
    stepsRem: sorted.length ? sorted : [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8],
    base: 1,
    note: sorted.length
      ? `${sorted.length} distinct rem spacing values were found in the stylesheet.`
      : 'No rem spacing was found; this is a conventional 8px-ish ramp.',
  };
}








export { toCss, toTailwind, toStyleDictionary, toFigmaVariables };