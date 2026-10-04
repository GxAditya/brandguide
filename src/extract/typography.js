/**
 * Typography extraction.
 *
 * Three sources, in order of trust:
 *   1. `@font-face` declarations — the fonts the site actually ships
 *   2. `font-family` declarations weighted by frequency — the families actually used
 *   3. font CDN links (`fonts.googleapis.com`, Fontsource, Bunny, Adobe) — the vendor
 *
 * The tricky part is not finding fonts, it is *not reporting the framework's*
 * fonts. Tailwind's preflight declares `-apple-system, BlinkMacSystemFont` on
 * every element; Bootstrap declares four fallbacks nobody uses. Those are
 * filtered by frequency relative to the site's own choices.
 */

import {
  stripComments, parseFontFaces, parseCustomProperties, resolveCustomProperty,
  parseFontFamilyDeclarations, splitFontStack, parseTypeDetail, parseTypeSizes,
} from '../lib/css.js';

/** CSS keywords that appear in a font-family list but name no typeface. */
const CSS_KEYWORDS = new Set([
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'currentcolor',
]);

/**
 * Icon fonts are real @font-face declarations and never a brand typeface.
 * They also tend to be the only fonts some sites ship, so filtering them is
 * what stops "Patagonia Icons" being reported as Patagonia's typeface.
 */
const ICON_FONT = /(icon|awesome|glyph|emoji|material-symbols|material-icons|font-?awesome|devicon|feather|octicons)/i;

/**
 * Pure generics. `sans-serif` appears in most font stacks and names no
 * typeface at all, so it should never be reported as one.
 */
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/**
 * Values that are not typefaces at all.
 *
 * A real stylesheet contained `font-family:object-fit\: cover`, a copy-paste
 * bug on the site itself. Any family name carrying a CSS escape or a colon has
 * leaked in from a utility class, so it is rejected on sight rather than
 * guessed at.
 */
function isPlausibleFamily(name) {
  if (!name) return false;
  if (name.includes('\\') || name.includes(':') || name.includes(';')) return false;
  if (/^\d/.test(name)) return false;
  if (CSS_KEYWORDS.has(name.toLowerCase())) return false;
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return false;
  if (ICON_FONT.test(name)) return false;
  // A generic `object-fit`/`display` value such as `cover` or `contain`.
  if (/^(cover|contain|fill|none|scale-down|auto|normal|inherit|initial)$/i.test(name)) return false;
  return true;
}

/** System stacks that are not really a brand decision unless they dominate. */
const SYSTEM_FAMILIES = new Set([
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto',
  'helvetica', 'helvetica neue', 'arial', 'sans-serif', 'serif', 'monospace',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'apple sd gothic neo',
  'noto sans', 'cantarell', 'times new roman', 'georgia', 'courier new',
  'inter var', 'inter',
]);

const CLASSIFIERS = [
  { kind: 'serif', re: /\b(serif|garamond|georgia|times|baskerville|didot|playfair|merriweather|lora|source serif|libre baskerville|dm serif|spectral|fraunces|cormorant|libre caslon|cinzel|pt serif|ibm plex serif|spectral)\b/i },
  { kind: 'sans', re: /\b(sans|grotesk|gothic|helvetica|inter|roboto|open sans|lato|montserrat|poppins|nunito|raleway|work ?sans|dm sans|manrope|figtree|space grotesk|archivo|barlow|raleway|outfit|sora)\b/i },
  { kind: 'mono', re: /\b(mono|code|courier|menlo|consolas|fira ?code|jetbrains|source ?code|ibm plex mono|space mono|inconsolata|roboto ?mono)\b/i },
  { kind: 'display', re: /\b(display|black|heavy|bold|grotesque|tight|compressed|serif ?display|ultra)\b/i },
];

const CDN_HINTS = [
  { re: /fonts\.googleapis\.com/i, vendor: 'Google Fonts' },
  { re: /fonts\.bunny\.net/i, vendor: 'Bunny Fonts' },
  { re: /use\.typekit\.net|typekit\.com/i, vendor: 'Adobe Fonts' },
  { re: /api\.fontshare\.com/i, vendor: 'Fontshare' },
  { re: /fonts\.fontawesome\.com|kit\.fontawesome\.com/i, vendor: 'Font Awesome' },
  { re: /cdn\.jsdelivr\.net\/npm\/@fontsource/i, vendor: 'Fontsource' },
];

/**
 * @param {{ sheets: object[], head: object }} input
 */
export function extractTypography({ sheets = [], head = {} }) {
  const combined = sheets.map((s) => stripComments(s.css)).join('\n');
  const props = parseCustomProperties(combined);

  const faces = parseFontFaces(combined).filter((f) => isPlausibleFamily(f.family));
  // `@font-face{font-family:X}` declares a font; it does not set any text in it.
  // Counting those as usage made every bundled webfont look like a typeface the
  // brand actually types with, which is how Vercel's five decorative
  // `GeistPixel*` graphics fonts ended up in its type system.
  const usageCss = combined.replace(/@font-face\s*\{[^}]*\}/gi, ' ');
  const declaredStacks = parseFontFamilyDeclarations(usageCss);
  const detail = parseTypeDetail(combined);
  const sizes = parseTypeSizes(combined);

  // --- Families, frequency weighted ---------------------------------------
  const tally = new Map();

  const bump = (name, patch) => {
    if (!isPlausibleFamily(name) || name.length > 64) return undefined;
    const key = name.toLowerCase();
    if (!tally.has(key)) {
      tally.set(key, { name, count: 0, stacks: new Set(), inFace: false, webfont: false, usedInStack: false, vendorSet: new Set(), weights: new Set() });
    }
    const entry = tally.get(key);
    Object.assign(entry, patch);
    return entry;
  };

  for (const face of faces) {
    const entry = bump(face.family, { inFace: true, webfont: true });
    if (!entry) continue;
    entry.count += 3; // @font-face is a strong declaration of intent
    entry.weights.add(normaliseWeight(face.weight));
    if (face.isGoogleFont) entry.vendorSet.add('Google Fonts');
    for (const fmt of face.formats) {
      if (fmt === 'woff2') entry.vendorSet.add('woff2');
    }
  }

  for (const rawStack of declaredStacks) {
    // `--bs-body-font-family: "Ridgeway Sans",system-ui,...!important` and
    // `font-family: var(--pata-font-serif)` are both common. A site that only
    // ever refers to its typeface through a custom property would otherwise
    // report no typeface at all.
    const stack = resolveStack(rawStack, props);
    const families = splitFontStack(stack);
    // In a stack only the first family is the choice; the rest are fallbacks.
    const [first, ...fallbacks] = families;
    if (!isPlausibleFamily(first)) continue;

    const entry = bump(first, {});
    if (!entry) continue;
    entry.count += 1;
    entry.usedInStack = true;
    entry.stacks.add(stack);
    entry.vendorSet.add('fallback');
    if (fallbacks.length) entry.stacks.add(fallbacks.join(', '));
  }

  // --- Google Fonts / vendor links in the head -----------------------------
  const headCss = headText(head);
  const vendorLinks = [];
  for (const hint of CDN_HINTS) {
    if (hint.re.test(headCss)) vendorLinks.push(hint.vendor);
  }
  // Family names out of a Google Fonts href, e.g. family=Inter:wght@400;700
  for (const m of headCss.matchAll(/fonts\.googleapis\.com\/css2\?([^"'&]*)/gi)) {
    for (const part of decodeURIComponent(m[1]).split('&')) {
      const [key, value] = part.split('=');
      if (key !== 'family') continue;
      const family = value.split(':')[0].replace(/\+/g, ' ').trim();
      const entry = bump(family, { webfont: true });
      if (!entry) continue;
      entry.count += 5;
      entry.usedInStack = true;
      entry.vendorSet.add('Google Fonts');
      for (const w of (value.split(':')[1] || '').split('@').pop()?.split(';') || []) {
        entry.weights.add(normaliseWeight(w));
      }
    }
  }

  // --- Rank ----------------------------------------------------------------
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const topCount = ranked[0]?.count || 1;

  const families = ranked
    /**
     * Two things must both be true before a family is reported.
     *
     * Used: the site actually sets text in it. Merely shipping a webfont is not
     * enough — Vercel bundles `GeistPixelCircle`, `GeistPixelSquare`,
     * `GeistPixelLine`, `GeistPixelGrid` and `GeistPixelTriangle`, decorative
     * graphics fonts no paragraph is ever set in.
     *
     * And either it is a real webfont the site chose, or the site leans on it
     * heavily. Without the second test every framework reset that declares
     * `-apple-system` on `html` and `*` reports as a brand typeface, because
     * those rules are everywhere and mean nothing.
     */
    .filter(
      (entry) =>
        entry.usedInStack && (entry.webfont || entry.count / topCount >= 0.5),
    )
    .slice(0, 8)
    .map((entry) => {
      const kind = classify(entry.name);
      const isSystem = SYSTEM_FAMILIES.has(entry.name.toLowerCase());
      return {
        family: entry.name,
        kind: isSystem && !entry.webfont ? 'system' : kind,
        weights: [...entry.weights].sort(),
        weightCount: entry.weights.size || 1,
        isWebfont: entry.webfont,
        declaredIn: entry.inFace ? '@font-face declaration' : 'font-family declaration',
        stacks: [...entry.stacks].slice(0, 3),
        vendors: [...entry.vendorSet].filter((v) => v !== 'fallback'),
        role: null,
        share: Number((entry.count / topCount).toFixed(2)),
        confidence: Number(
          Math.min(1, (entry.inFace ? 0.5 : 0.2) + (entry.webfont ? 0.3 : 0) + entry.count / 20).toFixed(2),
        ),
        source: {
          method: entry.inFace
            ? '@font-face declaration, used in a font-family rule'
            : 'font-family usage in stylesheet',
          detail: `${entry.count} weighted declaration${entry.count === 1 ? '' : 's'}`,
        },
      };
    });

  // Role assignment: the dominant family is the display face.
  const distinct = families.filter((f) => f.kind !== 'system' && f.kind !== 'mono');
  const heading = distinct[0] || families[0] || null;
  const body = distinct[1] || heading;
  const mono = families.find((f) => f.kind === 'mono') || null;

  if (heading) heading.role = 'heading';
  if (body && body !== heading) body.role = 'body';
  if (mono) mono.role = 'mono';

  // Two @font-face rules for the same family at the same weight would otherwise
  // report "100 100" as a weight range.
  for (const family of families) {
    family.weights = [...new Set(family.weights)];
    family.weightCount = family.weights.length || 1;
  }

  const scale = deriveTypeScale(sizes);

  return {
    families,
    pairing: {
      heading: heading?.family || null,
      body: body?.family || null,
      mono: mono?.family || null,
      rationale: buildPairingRationale(heading, body, mono),
    },
    scale,
    detail: {
      letterSpacingEm: detail.letterSpacingEm,
      lineHeight: detail.lineHeight,
      uppercaseUsage: detail.uppercaseCount,
    },
    source: {
      method: sheets.length
        ? `${faces.length} @font-face and ${declaredStacks.length} font-family declarations across ${sheets.length} stylesheet(s)`
        : 'no stylesheet available; type inferred from head metadata',
      vendorLinks: [...new Set(vendorLinks)],
      fontFaceCount: faces.length,
    },
  };
}

/**
 * Resolve a font stack that leads with `var(--token)`.
 *
 * Real sites declare their typefaces once and reference them everywhere:
 * `font-family: var(--pata-font-serif)`. Following the alias is the difference
 * between reporting "Copernicus" and reporting nothing at all.
 */
function resolveStack(stack, props) {
  const cleaned = String(stack || '').replace(/!important\s*$/i, '').trim();

  const varAtStart = cleaned.match(/^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/i);
  if (!varAtStart) return cleaned;

  const resolved = resolveCustomProperty(props, varAtStart[1]);
  // A fallback inside the var() is the site's own idea of the stack.
  return resolveStack(resolved || varAtStart[2] || '', props);
}

/**
 * A representative type scale, derived from the rem/px values actually present
 * in the stylesheet rather than invented.
 */
function deriveTypeScale(sizes) {
  const px = [];
  for (const { value } of sizes) {
    for (const m of value.matchAll(/(\d*\.?\d+)\s*(rem|px|em)/gi)) {
      const n = parseFloat(m[1]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const asRem = m[2].toLowerCase() === 'px' ? n / 16 : n;
      if (asRem >= 0.5 && asRem <= 6) px.push(Number(asRem.toFixed(3)));
    }
  }
  if (!px.length) return [];

  const counts = new Map();
  for (const v of px) counts.set(v, (counts.get(v) || 0) + 1);

  // One representative value per 0.05rem bucket, ranked by frequency.
  const buckets = new Map();
  for (const [value, count] of counts) {
    const key = (Math.round(value / 0.05) * 0.05).toFixed(2);
    const prev = buckets.get(key) || { value: 0, count: 0 };
    buckets.set(key, { value: prev.value + value * count, count: prev.count + count });
  }

  const ranked = [...buckets.values()]
    .map((b) => ({ rem: Number((b.value / b.count).toFixed(2)), count: b.count }))
    .sort((a, b) => b.rem - a.rem)
    .slice(0, 10);

  const NAMED = [
    [2.5, 'display'], [2, 'h1'], [1.5, 'h2'], [1.25, 'h3'],
    [1.125, 'h4'], [1, 'body'], [0.875, 'small'], [0.75, 'caption'],
  ];

  return ranked.map((entry) => {
    const match = NAMED.find(([rem]) => Math.abs(rem - entry.rem) < 0.3);
    return {
      name: match?.[1] || `${entry.rem}rem`,
      rem: entry.rem,
      px: Math.round(entry.rem * 16),
      usageCount: entry.count,
    };
  });
}

/**
 * Classify a family name.
 *
 * CamelCase names carry their own word boundaries — `GeistMono` is a monospace
 * face and `IBM Plex Sans` is a sans, but a `\b` boundary sees neither — so the
 * name is also tested with its case transitions turned into spaces.
 */
function classify(name) {
  const spaced = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const candidate of [name, spaced]) {
    for (const c of CLASSIFIERS) if (c.re.test(candidate)) return c.kind;
  }
  return 'sans';
}

function normaliseWeight(weight) {
  const value = String(weight || '400').trim().toLowerCase();
  if (/^[1-9]00$/.test(value)) return value;
  const named = { thin: '100', extralight: '200', light: '300', regular: '400', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900', heavy: '900' };
  return named[value] || value;
}

function buildPairingRationale(heading, body, mono) {
  if (!heading) return 'No font declarations were found in the stylesheets.';
  if (heading === body) {
    return `A single family, ${heading.family}, does all the work. Hierarchy comes from weight and size rather than from mixing typefaces.`;
  }
  return `${heading.family} leads headings and ${body.family} carries body copy${mono ? `, with ${mono.family} reserved for code and technical detail` : ''}.`;
}

/** Reconstruct a rough head text from the parsed head, for CDN link sniffing. */
function headText(head) {
  const parts = [];
  if (head?.stylesheets) parts.push(...head.stylesheets);
  if (head?.manifestUrl) parts.push(head.manifestUrl);
  if (head?.metas) parts.push(Object.values(head.metas).join(' '));
  return parts.join(' ');
}