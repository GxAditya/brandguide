/**
 * Colour extraction, in descending order of trust: design-system custom properties,
 * then colour-literal frequency, then `theme-color` as a fallback that never
 * competes. A declared token always outranks a frequency hit: on a Tailwind site
 * white is used more than any brand colour, so "used most" is not "the brand colour".
 */

import {
  parseColor, describeColour, contrastRatio, wcagGrade, mix, deltaE2000,
  rgbToHsl, nearestNamedColour, toHex,
} from '../lib/colour.js';
import {
  stripComments, parseCustomProperties, resolveCustomProperty, findColourOccurrences,
} from '../lib/css.js';

/**
 * Tokens are tiered before scoring: `--color-bg-primary` says the site considers
 * this its background, while `--header-bg` says one component tinted its header.
 */

/** Segments that mark a token as belonging to a deliberate design system. */
const NAMESPACES = new Set([
  'color', 'colors', 'colour', 'colours', 'theme', 'brand', 'ui', 'tokens',
  'token', 'semantic', 'app', 'ds', 'design', 'palette', 'base', 'global',
]);

/** Role words, mapped to the role they describe. */
const ROLE_WORDS = {
  primary: 'primary', brand: 'primary', main: 'primary', key: 'primary',
  secondary: 'secondary', accent: 'accent', highlight: 'accent',
  tertiary: 'tertiary',
  bg: 'background', background: 'background', canvas: 'background',
  page: 'background', body: 'background', backdrop: 'background',
  surface: 'surface', panel: 'surface', card: 'surface', elevated: 'surface',
  fg: 'text', foreground: 'text', text: 'text', ink: 'text',
  content: 'text', copy: 'text', label: 'text',
  muted: 'muted', subtle: 'muted', faint: 'muted', quaternary: 'muted',
  link: 'link', anchor: 'link', hyperlink: 'link',
  border: 'border', outline: 'border', divider: 'border', stroke: 'border',
  line: 'border', rule: 'border',
  success: 'success', positive: 'success',
  warning: 'warning', caution: 'warning',
  error: 'error', danger: 'error', destructive: 'error', critical: 'error',
  info: 'info',
};

const TEXT_WORDS = new Set(['text', 'fg', 'foreground', 'content']);

/**
 * Words that name where a colour is used, not what it is for.
 *
 * `--govuk-surface-text-colour` puts one of these first and a real role second.
 */
const CONTAINER_WORDS = new Set([
  'surface', 'panel', 'card', 'container', 'wrapper', 'shell', 'region',
  'block', 'tile', 'canvas', 'header', 'footer', 'hero', 'sidebar', 'modal',
]);

/** Raw colour words: a palette entry, not a role. */
const COLOUR_WORDS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'violet', 'indigo', 'pink', 'cyan', 'teal', 'magenta', 'lime', 'olive',
  'navy', 'amber', 'coral', 'salmon', 'khaki', 'plum', 'crimson', 'brown',
  'grey', 'gray', 'slate', 'zinc', 'stone', 'neutral', 'rose', 'sky',
  'emerald', 'turquoise', 'lavender', 'beige', 'ivory', 'tan', 'aqua', 'fuchsia',
]);

/** Suffixes that mean "a variant of", which demotes a token out of the palette. */
const VARIANT_SUFFIX = /^(hover|hovered|active|focus|focused|visited|pressed|selected|disabled|open|opened|closed|tint|shade|soft|hard|ghost|washed|faded|alpha|outline|ring|shadow|1|2|3|4|5|6|7|8|9|0|10|one|two|three|stronger|weaker|lighter|darker|inverse|invert|reversed|small|medium|large)$/i;

const TIERS = {
  declaredRole: 300, // namespaced design-system token carrying a role word
  bareRole: 250, // --bg-base, --text-color-regular
  paletteEntry: 95, // --color-white, --color-blue
  component: 25, // --graph-dot, --plan-tail-accent, plain hex frequency
};

const NEUTRAL_MAX_SATURATION = 0.14;

/**
 * Alpha below this is an overlay, not a brand colour. Several translucent tokens
 * collapse onto the same opaque RGB once alpha is dropped, which would otherwise
 * hand the guide a solid black "border colour" that exists nowhere.
 */
const OPAQUE_THRESHOLD = 0.6;

/** Colours closer than this in CIEDE2000 are the same colour to a designer. */
const DEDUPE_THRESHOLD = 4.5;

/**
 * Decide what a custom property is.
 * @param {string} name e.g. `--color-bg-primary`
 */
export function classifyToken(name) {
  const body = name.replace(/^--/, '').toLowerCase();
  const segments = body.split('-').filter(Boolean);
  if (!segments.length) return { tier: 'component', role: null, onPrimary: false, variant: false };

  // A numeric tail means a palette scale: --blue-500, --gray-200.
  if (/^\d+$/.test(segments[segments.length - 1])) {
    return { tier: 'paletteEntry', role: null, onPrimary: false, variant: true };
  }

  const hasNamespace = segments.length > 1 && NAMESPACES.has(segments[0]);
  const endsWithColourWord = /^(colour|color)$/.test(segments[segments.length - 1] || '');
  const searchFrom = hasNamespace ? 1 : 0;

  // Collect every role word, then choose which one names the token.
  const roleHits = [];
  for (let i = searchFrom; i < segments.length; i += 1) {
    if (ROLE_WORDS[segments[i]]) roleHits.push({ index: i, role: ROLE_WORDS[segments[i]] });
  }

  let role = null;
  let roleIndex = -1;
  if (roleHits.length) {
    // A container word names a place, not a purpose: `--govuk-surface-text-colour`
    // is a text colour that happens to sit on a surface, and reading it as
    // `surface` gave GOV.UK a card colour identical to its body text.
    const first = roleHits[0];
    const next = roleHits.find((hit) => !CONTAINER_WORDS.has(segments[hit.index]));
    const chosen = first && CONTAINER_WORDS.has(segments[first.index]) && next ? next : first;
    role = chosen.role;
    roleIndex = chosen.index;
  }

  // A token whose only meaningful segment is a colour word is a palette entry.
  const meaningful = segments.slice(searchFrom).filter((s) => !VARIANT_SUFFIX.test(s));
  if (meaningful.length === 1 && COLOUR_WORDS.has(meaningful[0])) {
    return { tier: 'paletteEntry', role: null, onPrimary: false, variant: false };
  }

  if (!role) return { tier: 'component', role: null, onPrimary: false, variant: false, qualifier: null };

  const after = segments.slice(roleIndex + 1);
  const variant = after.some((s) => VARIANT_SUFFIX.test(s));

  // `--color-bg-primary` beats `--color-bg-level-2` and `--color-bg-tint`.
  const qualifier = after.find((s) => QUALIFIERS.has(s)) || null;

  // `--color-brand-text` names the text colour *on* the brand colour.
  const onPrimary = role === 'primary' && after.some((s) => TEXT_WORDS.has(s));

  // A trailing `colour`/`color` marks a design-system token whatever the prefix is
  // called: GOV.UK ships `--govuk-brand-colour` and `--govuk-text-colour`, and
  // neither would be recognised without this rule.
  const namespacedByColourWord = endsWithColourWord && segments.length >= 3;

  // A bare token is only trusted when the role word leads the whole name
  // (`--bg-base`). `--header-bg` leads with a component name, so it stays
  // component-scoped.
  const tier = hasNamespace
    ? 'declaredRole'
    : namespacedByColourWord
      ? 'declaredRole'
      : ROLE_WORDS[segments[0]]
        ? 'bareRole'
        : 'component';

  return { tier, role, onPrimary, variant, qualifier };
}

/** Strength order within a role: primary > secondary > tertiary > default. */
const QUALIFIERS = new Map([
  ['primary', 4], ['base', 3], ['main', 3], ['default', 2],
  ['secondary', 2], ['tertiary', 1],
]);

/**
 * Scope words. `--govuk-body-background-colour` is the page background;
 * `--govuk-template-background-colour` is one component.
 */
const PAGE_SCOPE = /(^|-)(body|page|global|document|root|app|site|main|default)(-|$)/;
const COMPONENT_SCOPE = new RegExp(
  `(^|-)(${[
    'template', 'layout', 'shell', 'chrome', 'view', 'card', 'panel', 'header', 'footer',
    'nav', 'navigation', 'hero', 'banner', 'modal', 'tooltip', 'dropdown', 'button', 'btn',
    'input', 'form', 'table', 'row', 'column', 'grid', 'cell', 'list', 'menu', 'tab', 'print',
    'tag', 'pill', 'badge', 'chip', 'switch', 'toolbar', 'sidebar', 'wrapper', 'container',
    'inner', 'outer', 'browser', 'popover', 'drawer', 'toast', 'accordion', 'pagination',
    'avatar', 'kbd', 'label', 'legend', 'divider', 'separator', 'scrollbar', 'caret',
    'chevron', 'handle', 'swatch', 'glyph', 'mark', 'wordmark', 'logo', 'icon', 'sticker',
    'thumbnail', 'preview', 'skeleton', 'spinner', 'loader', 'snippet', 'code', 'editor',
    'dock', 'titlebar', 'statusbar', 'breadcrumb', 'overlay', 'dialog', 'drawer',
  ].join('|')})(-|$)`, 'i');


export function extractColors({ sheets = [], head = {}, manifest = null }) {
  const combined = sheets.map((s) => stripComments(s.css)).join('\n');
  const props = parseCustomProperties(combined);
  const occurrences = findColourOccurrences(combined);
  /** @type {Map<string, object>} */
  const candidates = new Map();
  let overlays = 0;

  const upsert = (rgb, { source, method, detail, score, role, qualifier, tokenName, tier, variant }) => {
    if (!rgb || rgb.a === 0) return;
    // Overlays are counted but never become brand colours.
    if (rgb.a < OPAQUE_THRESHOLD) {
      overlays += 1;
      return;
    }
    const key = toHex(rgb);

    if (!candidates.has(key)) {
      candidates.set(key, {
        rgb, evidence: [], score: 0, roles: new Map(), tokens: new Set(), tier: 'component',
        onlyVariants: true,
      });
    }
    const entry = candidates.get(key);
    entry.score += score;
    entry.evidence.push({ source, method, detail: detail || null, token: tokenName || null });
    // A role can be claimed by several tokens; keep the strongest claim.
    if (role) {
      const strength = (qualifier ? QUALIFIERS.get(qualifier) : 0) + (TIERS[tier] / 100);
      const current = entry.roles.get(role) || 0;
      if (strength > current) entry.roles.set(role, strength);
    }
    if (tokenName) entry.tokens.add(tokenName);
    if (TIERS[tier] > TIERS[entry.tier]) entry.tier = tier;
    // Hover and tint shades are real, but they are not a colour a marketer
    // should be handed. Only an explicit `variant: false` clears the flag.
    if (variant === false) entry.onlyVariants = false;
  };

  // --- 1. Design-system tokens ---------------------------------------------
  //
  // Usage counts as much as the name: a token referenced in twenty rules is
  // load-bearing, one referenced once is a component constant that happens to be
  // named like a role. Notion declares `--browser-text-color` for its in-app
  // browser chrome and `--color-nav-text` for the nav bar; both read as "text"
  // until you notice neither is the colour of a paragraph.
  const usage = new Map();
  for (const name of props.keys()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    usage.set(name, (combined.match(new RegExp(`var\\(\\s*${escaped}`, 'g')) || []).length);
  }

  let tokenCount = 0;
  for (const name of props.keys()) {
    const classified = classifyToken(name);
    if (classified.tier === 'component') continue;

    const usedIn = usage.get(name) ?? 0;

    const rgb = parseColor(resolveCustomProperty(props, name));
    if (!rgb || rgb.a === 0) continue;

    tokenCount += 1;
    let score = classified.variant ? TIERS[classified.tier] * 0.55 : TIERS[classified.tier];
    if (classified.qualifier) score += (QUALIFIERS.get(classified.qualifier) - 1) * 40;

    // Page-level tokens outrank component-level ones of equal standing.
    if (PAGE_SCOPE.test(name)) score += 70;
    if (COMPONENT_SCOPE.test(name)) score -= 55;

    // Log scale, capped, so one runaway count cannot dominate and usage alone can
    // never beat a tier gap. A token referenced by nothing is demoted rather
    // than dropped: it can legitimately be applied only from inline styles.
    score += Math.min(60, Math.log2(usedIn + 1) * 22);
    if (usedIn === 0) score -= 45;

    upsert(rgb, {
      source: 'stylesheet',
      method: 'css-custom-property',
      detail: name,
      score,
      role: classified.role,
      qualifier: classified.qualifier,
      tokenName: name,
      tier: classified.tier,
      variant: classified.variant,
    });

    if (classified.onPrimary && rgb.a === 1) {
      upsert(rgb, {
        source: 'stylesheet',
        method: 'css-custom-property',
        detail: `${name} — text on the brand colour`,
        score: TIERS[classified.tier] + 25,
        role: 'onPrimary',
        qualifier: classified.qualifier,
        tokenName: name,
        tier: classified.tier,
      });
    }
  }

  // --- 2. Usage frequency, capped so it can never outrank a declared token --
  const maxFrequency = Math.max(1, ...occurrences.values());
  for (const [literal, count] of occurrences) {
    const rgb = parseColor(literal);
    if (!rgb || rgb.a === 0) continue;
    const isNeutral = rgbToHsl(rgb).s <= NEUTRAL_MAX_SATURATION;
    const share = count / maxFrequency;
    if (share < 0.04 && !isNeutral) continue;

    upsert(rgb, {
      source: 'stylesheet',
      method: 'colour-frequency',
      detail: `appears ${count}× in the CSS`,
      score: Math.min(60, 60 * share * (isNeutral ? 0.3 : 1)),
      tier: 'component',
    });
  }

  // --- 3. Browser-chrome colour: reported, but never allowed to compete ----
  const chromeSources = [
    head.themeColor && { value: head.themeColor, source: 'head', method: 'meta-theme-color', detail: '<meta name="theme-color">' },
    manifest?.themeColor && { value: manifest.themeColor, source: 'manifest', method: 'webmanifest-theme-color', detail: 'theme_color' },
  ].filter(Boolean);

  for (const item of chromeSources) {
    const rgb = parseColor(item.value);
    if (rgb) {
      upsert(rgb, { source: item.source, method: item.method, detail: item.detail, score: 25, tier: 'component' });
    }
  }

  // --- 4. Rank -------------------------------------------------------------
  const ranked = [...candidates.values()].map(buildToken).sort((a, b) => b.score - a.score);

  const isColourful = (t) => t.chroma >= 18 && t.lightness > 0.05 && t.lightness < 0.95;
  const colourful = ranked.filter(isColourful);
  const neutrals = ranked.filter((t) => !isColourful(t));

  const core = dedupeSimilar([
    ...pickByRole(ranked, 'primary').filter((t) => !t.onlyVariants),
    ...pickByRole(ranked, 'accent').filter((t) => !t.onlyVariants),
    ...pickByRole(ranked, 'secondary').filter((t) => !t.onlyVariants),
    ...colourful.filter((t) => t.tier !== 'component' && !t.onlyVariants).slice(0, 5),
    ...colourful.filter((t) => !t.onlyVariants).slice(0, 3),
  ]).slice(0, 8);

  const roles = assignRoles({ ranked, core, neutrals, head, manifest });

  return {
    tokens: core.length ? core : colourful.slice(0, 6),
    neutrals: neutrals.slice(0, 8),
    roles,
    neutralRamp: buildNeutralRamp(neutrals),
    source: {
      method: sheets.length
        ? `${sheets.length} stylesheet(s) read through TinyFish Fetch, plus head metadata`
        : 'head metadata only — no stylesheet was readable',
      designTokens: tokenCount,
      distinctColours: ranked.length,
      declaredColours: ranked.filter((t) => t.tier !== 'component').length,
      translucentOverlaysIgnored: overlays,
    },
    contrast: buildContrastMatrix(roles),
  };
}

/** Roles ordered so the most structurally important one is reported first. */
const ROLE_PRIORITY = ['primary', 'background', 'text', 'accent', 'secondary', 'border', 'surface', 'muted', 'link', 'onPrimary', 'success', 'warning', 'error', 'info', 'tertiary'];

function buildToken(entry) {
  const named = nearestNamedColour(entry.rgb);
  const desc = describeColour(entry.rgb);
  const sources = new Set(entry.evidence.map((e) => e.source));
  const agreement = Math.min(1, sources.size / 2);
  const declared = entry.tokens.length > 0;

  const roles = [...entry.roles.keys()].sort(
    (a, b) => (entry.roles.get(b) - entry.roles.get(a)) || (ROLE_PRIORITY.indexOf(a) - ROLE_PRIORITY.indexOf(b)),
  );

  return {
    ...desc,
    name: named.name,
    nameDistance: named.distance,
    role: roles[0] || null,
    roles,
    tier: entry.tier,
    onlyVariants: entry.onlyVariants,
    tokens: [...entry.tokens].slice(0, 6),
    score: Math.round(entry.score),
    confidence: Number(
      Math.min(1, (declared ? 0.55 : 0.2) + agreement * 0.25 + Math.min(entry.score / 300, 1) * 0.2).toFixed(2),
    ),
    declared,
    sources: [...sources],
    evidence: entry.evidence.slice(0, 4),
  };
}

function pickByRole(ranked, role) {
  return ranked.filter((t) => t.roles.includes(role));
}

/** Collapse colours a designer would call identical. */
function dedupeSimilar(tokens) {
  const out = [];
  for (const token of tokens) {
    const rgb = parseColor(token.hex);
    if (!rgb) continue;
    const tooClose = out.some((kept) => deltaE2000(rgb, parseColor(kept.hex)) < DEDUPE_THRESHOLD);
    if (!tooClose) out.push(token);
  }
  return out;
}

/**
 * Map colours onto designer roles. The neutral ramp stays out of `roles` — it is a
 * scale, not a role — and text comes from the far end of it relative to the
 * background's lightness.
 */
function assignRoles({ ranked, core, neutrals, head, manifest }) {
  const roles = {};
  const inferred = [];
  const shared = [];
  const claimed = [];

  /**
   * Assign a role from a declared token. `allowDuplicate` covers roles that
   * legitimately coincide: a link colour that *is* the brand colour is normal, an
   * accent identical to the primary is not a separate finding.
   */
  const take = (name, filter, { allowDuplicate = false } = {}) => {
    if (roles[name]) return;
    const pool = ranked.filter((t) => t.roles.includes(name) && filter(t));
    if (!pool.length) return;
    // Prefer a token the site named "...primary", then fall back to rank order.
    const hit = pool.find((t) => t.tokens.some((tok) => /(^|-)primary(-|$)/.test(tok))) || pool[0];

    const clash = claimed.find((hex) => deltaE2000(parseColor(hex), parseColor(hit.hex)) < DEDUPE_THRESHOLD);
    if (clash && !allowDuplicate) return;

    if (clash) shared.push(`${name} is the same colour as ${clash}`);
    else claimed.push(hit.hex);
    roles[name] = hit.hex;
  };
  /**
   * Chroma, not HSL saturation, decides whether a colour can play a brand role: a
   * pale grey reports high saturation near white, which is how a framework's default
   * link grey ends up reported as the brand's link colour.
   */
  const colourful = (t) => t.chroma >= 40;
  const statusColour = (t) => t.chroma >= 25;

  take('primary', colourful);
  take('background', () => true);
  take('text', (t) => t.lightness < 0.6);
  take('accent', colourful);
  take('secondary', colourful);
  take('surface', () => true, { allowDuplicate: true });
  // No chroma filter: a legitimate hairline can be almost neutral. Invisibility
  // is handled below, by comparing the border against the background.
  take('border', () => true, { allowDuplicate: true });
  take('muted', () => true, { allowDuplicate: true });
  take('link', colourful, { allowDuplicate: true });
  take('success', statusColour, { allowDuplicate: true });
  take('warning', statusColour, { allowDuplicate: true });
  take('error', statusColour, { allowDuplicate: true });
  take('onPrimary', () => true, { allowDuplicate: true });

  const ramp = buildNeutralRamp(neutrals);

  // Anything the site did not name is derived from what it did declare, and
  // flagged as inferred rather than passed off as measured. Background comes
  // first, because whether text should be light or dark depends on it.
  if (!roles.background) {    roles.background = head.themeColor || manifest?.themeColor || ramp['0'] || '#ffffff';
    inferred.push('background');
  }

  const bgL = rgbToHsl(parseColor(roles.background) || {}).l ?? 1;
  const isDark = bgL < 0.5;

  if (!roles.text) {
    roles.text = isDark ? ramp['100'] || '#f5f5f5' : ramp['900'] || '#111111';
    inferred.push('text');
  }
  if (!roles.primary) {
    const best = core.find((t) => t.chroma >= 40) || ranked.find((t) => t.chroma >= 40);
    roles.primary = best?.hex || roles.text;
    inferred.push('primary');
  }
  if (!roles.accent && roles.primary) {
    // Only a genuinely different hue counts. White is far from the brand hue in
    // Lab distance but is not an accent.
    const alt = core.find(
      (t) => t.chroma >= 40 && deltaE2000(parseColor(t.hex), parseColor(roles.primary)) > 40,
    );
    if (alt) {
      roles.accent = alt.hex;
      inferred.push('accent');
    }
  }

  const bg = parseColor(roles.background);
  const fg = parseColor(roles.text);

  if (!roles.onPrimary && fg) {
    roles.onPrimary =
      contrastRatio(parseColor('#ffffff'), fg) >= contrastRatio(parseColor('#000000'), fg)
        ? '#ffffff'
        : '#000000';
    inferred.push('onPrimary');
  }
  if (!roles.surface && bg && fg) {
    roles.surface = toHex(mix(bg, fg, 0.04));
    inferred.push('surface');
  }
  if (!roles.border || (bg && deltaE2000(parseColor(roles.border), bg) < DEDUPE_THRESHOLD)) {
    // A border the same colour as the page is invisible, so derive a real hairline.
    roles.border = bg ? toHex(mix(bg, fg || { r: 0, g: 0, b: 0, a: 1 }, 0.14)) : roles.border;
    inferred.push('border');
  }
  if (!roles.muted && bg && fg) {
    roles.muted = toHex(mix(fg, bg, isDark ? 0.45 : 0.38));
    inferred.push('muted');
  }
  if (!roles.link && roles.primary) {
    // A link that is simply the brand colour is a legitimate finding, not a gap.
    roles.link = roles.primary;
    shared.push('link is the same colour as primary');
  }

  // Inferred only when the site declared no status token and a conventional palette
  // entry exists. Green-means-success is close to universal, but it is still an
  // inference, so it is labelled as one.
  const STATUS_FALLBACK = { success: /green/, warning: /yellow|orange|amber/, error: /red|crimson/ };
  for (const [role, re] of Object.entries(STATUS_FALLBACK)) {
    if (roles[role]) continue;
    const hit = ranked.find((t) => t.chroma >= 40 && t.tokens.some((tok) => re.test(tok)));
    if (hit) {
      roles[role] = hit.hex;
      inferred.push(role);
    }
  }

  for (const key of ROLE_KEYS) {
    if (!roles[key]) continue;
    const parsed = parseColor(roles[key]);
    if (parsed) roles[key] = toHex(parsed);
  }

  roles.declaredThemeColor = head.themeColor || manifest?.themeColor || null;
  roles.inferred = inferred;
  roles.shared = shared;
  roles.darkSurface = isDark;
  return roles;
}

const ROLE_KEYS = [
  'primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted',
  'border', 'link', 'success', 'warning', 'error', 'onPrimary',
];

/**
 * Build a 0..900 neutral ramp from whatever greys the site actually uses, then
 * fill any gaps with tints and shades of the most common one.
 */
function buildNeutralRamp(neutrals) {
  const ramp = {};
  const sorted = neutrals
    .filter((t) => t.alpha >= 1)
    .slice()
    .sort((a, b) => a.lightness - b.lightness)
    .map((t) => ({ hex: t.hex, l: t.lightness }));

  const stops = [
    ['0', 1], ['50', 0.97], ['100', 0.94], ['200', 0.88], ['300', 0.79],
    ['400', 0.66], ['500', 0.53], ['600', 0.42], ['700', 0.33],
    ['800', 0.24], ['900', 0.16],
  ];

  if (sorted.length >= 3) {
    const base = parseColor(sorted[Math.floor(sorted.length / 2)].hex) || parseColor('#808080');
    const white = { r: 255, g: 255, b: 255, a: 1 };
    for (const [key, target] of stops) {
      const match = sorted.find((s) => Math.abs(s.l - target) < 0.045);
      ramp[key] = match ? match.hex : toHex(mix(white, base, 1 - target));
    }
  } else {
    const defaults = {
      0: '#ffffff', 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
      400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
    };
    for (const [key] of stops) ramp[key] = defaults[key];
  }

  return ramp;
}

/** Real foreground/background pairs a designer would actually put on a page. */
function buildContrastMatrix(roles) {
  const pairs = [
    { fg: 'text', bg: 'background', use: 'body copy on the page' },
    { fg: 'link', bg: 'background', use: 'link text on the page' },
    { fg: 'text', bg: 'surface', use: 'body copy on a card' },
    { fg: 'primary', bg: 'surface', use: 'accent on a card' },
    { fg: 'onPrimary', bg: 'primary', use: 'button label on a primary button' },
    { fg: 'muted', bg: 'background', use: 'secondary text on the page' },
    { fg: 'text', bg: 'border', use: 'text against a hairline panel' },
  ];

  const out = [];
  for (const pair of pairs) {
    const fg = parseColor(roles[pair.fg]);
    const bg = parseColor(roles[pair.bg]);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    out.push({
      ...pair,
      foreground: toHex(fg),
      background: toHex(bg),
      ratio,
      ...wcagGrade(ratio),
    });
  }
  return out;
}