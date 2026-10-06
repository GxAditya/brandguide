/**
 * The deck: composes a paged brand guide from an extracted guide object.
 *
 * Without an LLM: seven measured pages (cover, logomark, logotype, palette, typeface,
 * weights, type scaling), each filled only from values read off the live site. With
 * one: the full written document, bounded by the requested page count. A page is only
 * emitted if it can be filled truthfully; a shortfall is stated, not padded.
 */

/* ── Section map, for the full document ─────────────────────────────────── */

const SECTIONS = [
  { key: 'intro', label: 'Introduction' },
  { key: 'logo', label: 'Logo' },
  { key: 'color', label: 'Color' },
  { key: 'type', label: 'Typography' },
  { key: 'method', label: 'Method' },
];

const SECTION_LABEL = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]));
const SECTION_ORDER = SECTIONS.map((s) => s.key);

function majorFor(sectionKey) {
  const index = SECTION_ORDER.indexOf(sectionKey);
  return index >= 0 ? index + 1 : 1;
}

/* ── Colour maths, used for swatch ink and the tint strips ──────────────── */

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbParts(hex) {
  return parseHex(hex) || { r: 0, g: 0, b: 0 };
}

function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(a, b, amount) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex({
    r: x.r + (y.r - x.r) * amount,
    g: x.g + (y.g - x.g) * amount,
    b: x.b + (y.b - x.b) * amount,
  });
}

function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 1;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ink that stays legible on an arbitrary swatch. */
function inkOn(hex) {
  return luminance(hex) > 0.42 ? '#000000' : '#ffffff';
}

/** Tint strip mixed toward whichever end keeps it distinct from the swatch. */
function tintStrip(hex, step) {
  const towardDark = step > 0.5;
  return {
    hex: mix(hex, towardDark ? '#000000' : '#ffffff', step),
    ink: towardDark ? '#ffffff' : '#000000',
  };
}

function cmykOf(hex) {
  const { r, g, b } = rgbParts(hex);
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const k = 1 - Math.max(R, G, B);
  if (k >= 0.999) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: Math.round(((1 - R - k) / (1 - k)) * 100),
    m: Math.round(((1 - G - k) / (1 - k)) * 100),
    y: Math.round(((1 - B - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  };
}

/* ── DOM helpers ────────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function titleCase(text) {
  return String(text || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function lowerFirst(text) {
  const s = String(text || '');
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* ── The page shell ─────────────────────────────────────────────────────── */

/** A page: running header, rule, then body. */
function shell({ plate, bare, section, subsection, index }) {
  const page = el('div', 'page');
  if (plate) page.dataset.plate = 'true';

  const head = el('div', 'page-head');

  if (!bare) {
    const left = el('div');
    left.append(el('span', 'head-topic', `Topic ${index.topic}`));
    left.append(el('span', 'head-sub', `Page: ${index.page}`));

    const mid = el('div');
    mid.append(el('span', 'head-sub', section));
    mid.append(el('span', 'head-sub', subsection));

    head.append(left, mid);
  }

  const body = el('div', 'page-body');
  // `head-rule` carries its own spacing: the reference puts the running rule
  // further below the header than an in-body rule sits below a section title.
  page.append(head, el('hr', 'page-rule head-rule'), body);
  return { page, body };
}

/* ── Page renderers ─────────────────────────────────────────────────────── */

/** The mark plus wordmark, which is what a cover is for. `primary` is usually just the app icon. */
function lockupAsset(logos) {
  return logos?.lockup || logos?.primary || null;
}

function renderCover(body, spec) {
  const wrap = el('div', 'cover-lockup');

  if (spec.mark) wrap.append(spec.mark);

  // The brand's own capitalisation: "tailwindcss" must not be set as "TAILWIND
  // CSS". The reference reads uppercase only because that is how its own wordmark
  // happens to be drawn.
  wrap.append(el('p', 'cover-name', spec.name));
  wrap.append(el('p', 'cover-sub', 'Brand Guidelines'));

  body.append(wrap);
}

/** Title in the left column, copy beside it, then a framed specimen panel. */
function renderSplit(body, spec) {
  const head = el('div', 'split-head');
  head.append(el('h2', 't-split', spec.title));

  const copy = el('div', `split-copy${spec.columns > 1 ? ' two' : ''}`);
  for (const paragraph of spec.paragraphs) {
    const col = el('div');
    for (const text of paragraph) {
      if (text) col.append(el('p', spec.lead ? 'lead' : '', text));
    }
    copy.append(col);
  }
  head.append(copy);
  body.append(head);

  if (!spec.panel) return;

  const panel = el('div', 'plate-panel');
  panel.dataset.light = spec.panel.light ? 'true' : 'false';
  if (spec.panel.empty) {
    panel.dataset.empty = 'true';
    panel.textContent = spec.panel.empty;
  } else {
    panel.append(spec.panel.node);
  }
  body.append(panel);
}

/** Page title, set above the rule as the template does on list pages. */
function pageTitle(body, text) {
  if (text) body.append(el('h2', 't-split', text));
}

/** A list of label and body pairs, separated by sparse rules. */
function renderRows(body, spec) {
  pageTitle(body, spec.title);
  body.append(el('hr', 'page-rule'));
  const list = el('div', 'rows has-head');
  for (const row of spec.rows) {
    const line = el('div', 'row');
    line.append(el('p', `row-label${row.monoLabel ? ' mono' : ''}`, row.label));

    const col = el('div', 'row-body');
    if (row.body) col.append(el('p', '', row.body));
    if (row.note) col.append(el('p', 'row-note', row.note));
    if (row.quote) {
      const quote = el('blockquote', '', `“${row.quote}”`);
      if (row.source) quote.append(el('cite', '', row.source));
      col.append(quote);
    }
    line.append(col);
    list.append(line);
  }
  body.append(list);
}

/** Swatch columns with RGB and CMYK values, and four tint strips at the foot. */
function renderPalette(body, spec) {
  const grid = el('div', 'palette');
  grid.dataset.count = String(Math.min(spec.colors.length, 6));

  for (const color of spec.colors) {
    const col = el('div', 'palette-col');

    const swatch = el('div', 'palette-swatch');
    swatch.style.background = color.hex;
    swatch.style.color = inkOn(color.hex);
    swatch.append(el('span', 'on-color', hex(color.hex)));

    const meta = el('div', 'palette-meta');
    meta.append(el('p', 'palette-name', color.name));

    // Two side-by-side value columns, as in the reference: CMYK on the left, RGB on
    // the right. One interleaved stack would be twice as tall for no gain.
    const rgb = rgbParts(color.hex);
    const cmyk = cmykOf(color.hex);
    const values = el('div', 'palette-values');

    const ink = el('dl', 'palette-cmyk');
    for (const [key, value] of [['C', cmyk.c], ['M', cmyk.m], ['Y', cmyk.y], ['K', cmyk.k]]) {
      ink.append(el('dt', '', key), el('dd', '', String(value)));
    }

    const light = el('dl', 'palette-cmyk');
    for (const [key, value] of [['R', rgb.r], ['G', rgb.g], ['B', rgb.b]]) {
      light.append(el('dt', '', key), el('dd', '', String(value)));
    }

    values.append(ink, light);
    meta.append(values);

    const tints = el('div', 'tints');
    for (const step of [0.2, 0.4, 0.6, 0.8]) {
      const strip = tintStrip(color.hex, step);
      const cell = el('div', 'tint', `${Math.round(step * 100)}%`);
      cell.style.background = strip.hex;
      cell.style.color = strip.ink;
      tints.append(cell);
    }

    col.append(swatch, meta, tints);
    grid.append(col);
  }
  body.append(grid);
}

/** Contrast pairs, two across, each drawn in its own foreground and background. */
function renderPairs(body, spec) {
  pageTitle(body, spec.title);
  const grid = el('div', 'pairs');
  for (const pair of spec.pairs) {
    const cell = el('div', 'pair-cell');
    cell.style.background = pair.background;
    cell.style.color = pair.foreground;
    cell.append(el('p', 'pair-sample', pair.sample));
    const meta = el('div', 'pair-meta');
    meta.append(el('span', '', `${pair.ratio}:1`));
    meta.append(el('span', '', pair.label));
    meta.append(el('span', '', pair.use));
    cell.append(meta);
    grid.append(cell);
  }
  body.append(grid);
}

const GLYPH_SETS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789° (!#$%&?@)',
];

/** Weight specimens, one row per weight. */
function renderWeights(body, spec) {
  pageTitle(body, spec.title);
  body.append(el('hr', 'page-rule'));
  for (const row of spec.rows) {
    const line = el('div', 'specimen-row is-weights');

    const left = el('div');
    left.append(el('p', 'weight-name', row.label));
    if (row.family) {
      const supply = row.webfont === false ? 'system or local' : 'webfont';
      left.append(el('p', 'weight-meta', `${row.family} · ${supply}`));
    }

    const right = el('div');
    if (row.face) right.style.setProperty('--face-brand', row.face);
    GLYPH_SETS.forEach((glyphs, index) => {
      const line2 = el('p', index === 0 ? 'specimen-glyphs' : 'weight-glyphs', glyphs);
      line2.style.fontWeight = row.weight;
      right.append(line2);
    });

    line.append(left, right);
    body.append(line);
  }
}

/** Size ramp, one row per measured step. */
function renderScaling(body, spec) {
  pageTitle(body, spec.title);
  body.append(el('hr', 'page-rule'));
  for (const row of spec.rows) {
    const line = el('div', 'specimen-row');
    line.append(el('p', 'specimen-label mono', `${row.px} Px`));
    const sample = el('p', 'specimen-sample', row.sample);
    sample.style.fontSize = `${Math.min(row.px, 64)}px`;
    line.append(sample);
    if (row.note) line.append(el('p', 'row-note', row.note));
    body.append(line);
  }
}

/** The source register. */
function renderList(body, spec) {
  pageTitle(body, spec.title);
  body.append(el('hr', 'page-rule'));
  const list = el('ul', 'source-list');
  list.style.marginTop = '26px';
  for (const item of spec.items) list.append(el('li', '', item));
  body.append(list);
}

/** Per-section confidence. */
function renderConfidence(body, spec) {
  pageTitle(body, spec.title);
  const grid = el('div', 'conf-grid');
  for (const section of spec.sections) {
    const cell = el('div', 'conf-cell');
    cell.append(el('p', 'conf-score', `${Math.round(section.score * 100)}%`));
    cell.append(el('p', 'conf-name', section.label));
    cell.append(el('p', 'conf-grade', `${section.grade} confidence`));
    grid.append(cell);
  }
  body.append(grid);
  if (spec.note) {
    const note = el('p', 'fine', spec.note);
    note.style.marginTop = '18px';
    body.append(note);
  }
}

/* ── Specimen panel contents ────────────────────────────────────────────── */

/**
 * A logo node. An `<img>` cannot inherit from the page, so a `currentColor` logo
 * arrives as a flat black shape; inlined SVG resolves against the wrapper instead.
 * `silent` drops the node on failure rather than printing a message on the cover.
 */
function logoImage(logo, className, { silent = false } = {}) {
  if (logo?.svg) {
    const holder = document.createElement('span');
    holder.className = className;

    // `inherit` logos carry no fill, so give them the panel's ink explicitly.
    if (logo.svgTone === 'inherit') holder.style.color = 'currentColor';

    try {
      const doc = new DOMParser().parseFromString(logo.svg, 'image/svg+xml');
      const svg = doc.documentElement;
      if (svg && svg.nodeName.toLowerCase() === 'svg') {
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        holder.append(document.importNode(svg, true));
        return holder;
      }
    } catch {
      // A parse error yields a <parsererror> root rather than throwing, so fall
      // through to the URL below.
    }
  }

  if (!logo?.url) return el('span', className);

  const img = document.createElement('img');
  img.className = className;
  img.src = logo.url;
  img.alt = '';
  img.decoding = 'sync';
  img.addEventListener('error', () => {
    if (silent) img.remove();
    else img.replaceWith(el('p', 'fine', 'logo asset did not load'));
  });
  return img;
}

/**
 * Whether the plate a mark sits on should be light. One-sided on purpose: only a
 * mark measured dark needs flipping, since that is the case that would otherwise be
 * invisible on the dark plate.
 */
function plateIsLight(tone) {
  return tone === 'dark';
}

/** The brand's own name, never the URL it was reached at. */
function brandName(identity) {
  return String(identity?.name || identity?.domain || 'Unknown brand').trim();
}

/** Avoids naming the family twice when the extractor's rationale already opens with it. */
function logotypeSentence(family, rationale) {
  if (!family) return 'No heading typeface was declared by this site, so no logotype can be set from the extraction.';
  if (!rationale) return `The wordmark is set in ${family}.`;

  const opensWithFamily = rationale.toLowerCase().startsWith(`${family.toLowerCase()},`);
  if (opensWithFamily) return `The wordmark is set in ${rationale}`;
  return `The wordmark is set in ${family}. ${rationale}`;
}

/** The wordmark as set type, not cropped out of a lockup file. */
function wordmarkNode(name) {
  const node = el('p', 'specimen-sample', name);
  node.style.fontSize = '86px';
  return node;
}

/**
 * The logotype page, shared by both decks. The wordmark belongs to exactly one place,
 * so it is set as type in the brand's heading face rather than cropped from a lockup.
 */
function logotypePageSpec(name, typography) {
  const pairing = typography.pairing || {};
  const headingFamily = pairing.heading;
  const family = (typography.families || []).find((f) => f.family === headingFamily);

  return {
    render: 'split',
    title: 'LOGOTYPE',
    columns: 2,
    paragraphs: [
      [logotypeSentence(headingFamily, pairing.rationale)],
      [headingFamily
        ? `That family was resolved from the site's own type tokens and is ${family?.isWebfont ? 'shipped by the site as a webfont' : 'named by the site but not shipped as a webfont'}.`
        : 'A logotype is a written element, so it is shown here as the brand writes its own name.'],
    ],
    panel: { light: true, node: wordmarkNode(name) },
  };
}

function typePanel(family) {
  const node = el('p', 'specimen-sample', family);
  node.style.fontSize = '112px';
  node.style.lineHeight = '1.02';
  node.style.overflowWrap = 'anywhere';
  return node;
}

/* ── Row content helpers ────────────────────────────────────────────────── */

function sampleFor(use) {
  if (/link/i.test(use)) return 'Read the guide';
  if (/button|cta|primary|action/i.test(use)) return 'Get started';
  if (/muted|secondary|subtle/i.test(use)) return 'Supporting note';
  if (/heading|display|title/i.test(use)) return 'A clear heading';
  return 'Body copy at reading size';
}

/**
 * `font-weight: 100 900` is a variable axis, not two weights, so a range is sampled
 * at the stops a brand guide documents. Taking its first digits would label every row
 * "Thin".
 */
function weightStops(weights, limit = 4) {
  const discrete = [];
  let axis = null;

  for (const declared of weights) {
    const range = /(\d{3})\s*(?:-|\s)\s*(\d{3})/.exec(declared);
    if (range) {
      axis = [range[1], range[2]];
      continue;
    }
    const single = /(\d{3})/.exec(declared);
    if (single) discrete.push(single[1]);
  }

  if (discrete.length) return { stops: discrete.slice(0, limit), axis: null };
  if (!axis) return { stops: [], axis: null };

  // Regular through Bold, filtered to what the axis can actually render.
  const wanted = ['400', '500', '600', '700'].filter(
    (n) => Number(n) >= Number(axis[0]) && Number(n) <= Number(axis[1]),
  );
  return { stops: (wanted.length ? wanted : [axis[0]]).slice(0, limit), axis };
}

const WEIGHT_NAMES = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'Demi-Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black',
};

function expandWeights(family) {
  const { stops, axis } = weightStops(family.weights || [], 4);
  const provenance = [axis ? `variable ${axis[0]}-${axis[1]}` : null, family.kind]
    .filter(Boolean).join(' · ');

  return stops.map((weight) => ({
    label: WEIGHT_NAMES[weight] || weight,
    meta: `${weight} · ${provenance}`,
    weight,
    family: family.family,
    webfont: Boolean(family.isWebfont),
    // A mono family has to be set in a mono stack or the specimen is a lie.
    face: family.kind === 'mono' ? 'var(--face-mono)' : 'var(--face-brand)',
  }));
}

function dedupeScale(scale) {
  const seen = new Set();
  const out = [];
  for (const step of scale) {
    if (seen.has(step.px)) continue;
    seen.add(step.px);
    out.push(step);
  }
  return out.sort((a, b) => b.px - a.px);
}

/** Map a CSS token name to the label the template would print. */
function scaleLabel(name) {
  const key = String(name || '').toLowerCase();
  const heading = /^h([1-6])$/.exec(key);
  if (heading) return `Heading ${heading[1]}`;
  if (/display|hero|cover/.test(key)) return 'Display';
  if (/lead|subtitle/.test(key)) return 'Lead';
  if (/body|base|paragraph/.test(key)) return 'Body';
  if (/caption|small|meta/.test(key)) return 'Caption';
  if (/button|cta/.test(key)) return 'Button';
  if (/label/.test(key)) return 'Label';
  if (/title/.test(key)) return 'Title';
  return titleCase(name) || 'Heading 1';
}

function hex(value) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb).toUpperCase() : '';
}

const TOKEN_NAMESPACES = new Set(['color', 'colour', 'colours', 'colors', 'bs', 'govuk', 'theme', 'palette', 'root']);

/**
 * Roles too generic to stand alone as a swatch name.
 *
 * "Primary" and "Secondary" are handed out freely, and GOV.UK genuinely assigns
 * "primary" to both its white and its blue. When the site has said something
 * more specific, prefer that.
 */
const GENERIC_ROLES = new Set(['primary', 'secondary']);

/** The site's own name for a colour, from the custom property that declared it. */
function fromTokenName(token) {
  const raw = token.tokens?.find((name) => typeof name === 'string');
  if (!raw) return '';

  const parts = raw.replace(/^--/, '').split('-').filter(Boolean);
  while (parts.length > 1 && TOKEN_NAMESPACES.has(parts[0].toLowerCase())) parts.shift();

  const words = parts.slice(0, 3).map((word) => word.toLowerCase());
  if (words.length > 2 && /colou?rs?$/.test(words[words.length - 1])) words.pop();

  return titleCase(words.join(' '));
}

/** Name each swatch, avoiding repeats on one spread: role, then CSS token, then index. */
function swatchNames(tokens) {
  const used = new Set();

  return tokens.map((token, index) => {
    const role = (token.role || token.roles?.[0] || '').toLowerCase();
    let name = role && !GENERIC_ROLES.has(role) ? titleCase(role) : '';

    if (!name || used.has(name)) name = fromTokenName(token);
    if (!name || used.has(name)) name = titleCase(token.name || `Color ${index + 1}`);
    if (used.has(name)) name = `${name} ${index + 1}`;

    used.add(name);
    return name;
  });
}

/** Quotes already spent on the current spread. Reset by the composer. */
const printedEvidence = new Set();

/** Two pillars can share a headline; quoting the same sentence twice reads as a bug. */
function pillarEvidence(pillar) {
  const quote = (pillar.support || []).find((s) => s?.text && !printedEvidence.has(s.text));
  if (quote) {
    printedEvidence.add(quote.text);
    return quote.text;
  }
  return `Appears on ${Math.round((pillar.prevalence || 0) * 100)}% of the pages read.`;
}

/** A meta description often opens with the name already; prefixing it repeats the name. */
function aboutSentence(identity) {
  const description = String(identity.description || '').trim();
  const name = brandName(identity);
  if (!name || !description) return description || name;
  if (description.toLowerCase().startsWith(name.toLowerCase())) return description;
  return `${name}, ${description}`;
}

/** "1 colour" but "6 colours", so a counted claim reads as English. */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Narration usually answers with a sentence that already names the brand, so the
 * prefix and the trailing stop are applied only when the line does not stand alone.
 */
function aimStatement(positioning, name) {
  const text = String(positioning || '').trim().replace(/[.\s]+$/, '');
  if (!text) return null;

  const standsAlone = name && text.toLowerCase().startsWith(`${name.toLowerCase()} `);
  return standsAlone ? `${text}.` : `Our aim is ${lowerFirst(text)}.`;
}

/**
 * The two columns of the introduction. This page cannot be assembled from a hex
 * value, so it is written from what the extraction measured and what the narration
 * said about the voice, asserting nothing else.
 *
 * @param {object} guide
 * @returns {string[][]} one array of sentences per column
 */
function introductionColumns(guide) {
  const identity = guide.identity || {};
  const name = brandName(identity);
  const colors = guide.colors?.tokens || [];
  const families = guide.typography?.families || [];
  const prov = guide.provenance || {};
  const narrative = guide.narrative || {};
  const verifiedLogo = Boolean(guide.logos?.primary?.url);

  const left = [
    `This document sets out how ${name} presents itself. It was assembled from the live site rather than from a design file, so every colour, typeface and logo in it is one the site uses today.`,
  ];

  const described = aboutSentence(identity);
  if (described && described !== name) left.push(described);

  left.push(
    `What could be measured, was measured: ${plural(colors.length, 'colour')} resolved from the site's own stylesheets`
    + ` and ${plural(families.length, 'typeface')} taken from its font rules`
    + `${verifiedLogo ? ', with every logo asset fetched back and confirmed before it was used here' : ''}.`,
  );

  const right = [];

  // The narration layer's read on the voice: the one thing on this page that is
  // written rather than measured, so it belongs in the introduction.
  if (narrative.toneSummary) right.push(narrative.toneSummary);

  right.push(
    'Read the palette, the type scale and the logo pages as the reference for anything new that carries the name. '
    + 'Each records the values in use now, closely enough to match without guesswork.',
  );

  right.push(
    prov.pagesRead?.length
      ? `It was built from ${plural(prov.pagesRead.length, 'page')} read through TinyFish Fetch, `
        + `${plural(prov.stylesheetsRead?.length || 0, 'stylesheet')} read back as raw CSS, and `
        + `${plural(guide.voice?.sentencesAnalysed || 0, 'sentence')} measured for tone. `
        + 'The pages at the end record where each value came from.'
      : 'The pages at the end record where each value came from.',
  );

  return [left, right];
}

/* ── The deterministic deck: seven measured pages ───────────────────────── */

/**
 * The only pages a brand can be documented with without writing anything. The prose
 * stays descriptive of the extraction, never of the brand: "this asset was fetched
 * back and confirmed" is true, "this symbolises our precision" would be invention.
 *
 * Topic numbers are fixed to the reference deck: 2.1, 2.2, 3.1, 4.1, 4.2, 4.3.
 */
function measuredDeck(guide) {
  const identity = guide.identity || {};
  const logos = guide.logos || {};
  const colors = guide.colors || {};
  const typography = guide.typography || {};
  const name = brandName(identity);

  const pages = [];

  /* Cover ---------------------------------------------------------------- */
  pages.push({
    kind: 'cover',
    label: 'Cover',
    topic: null,
    page: null,
    spec: () => ({
      render: 'cover',
      name,
      markUrl: logos.primary?.url || null,
    }),
  });
  /* Logomark ------------------------------------------------------------- */
  if (logos.primary?.url) {
    const primary = logos.primary;
    const source = logos.source || {};
    pages.push({
      kind: 'split',
      label: 'Logomark',
      section: 'Logo',
      topic: '2.1',
      page: 2,
      spec: () => ({
        render: 'split',
        title: 'LOGOMARK',
        columns: 2,
        paragraphs: [
          [`${name} declares its image assets in the document head. This mark was chosen by the extractor from ${source.candidates ?? 'the declared'} candidate${source.candidates === 1 ? '' : 's'}, and each candidate URL was fetched back before it could be used.`],
          [primary.reason || 'Declared in the document head.'],
        ],
        panel: { light: plateIsLight(primary.svgTone), node: logoImage(primary, 'mark') },
      }),
    });
  }

  /* Logotype ------------------------------------------------------------- */
  const headingFamily = typography.pairing?.heading;
  if (name) {
    pages.push({
      kind: 'split',
      label: 'Logotype',
      section: 'Logo',
      topic: '2.2',
      page: 3,
      spec: () => logotypePageSpec(name, typography),
    });
  }

  /* Color palette -------------------------------------------------------- */
  const tokens = colors.tokens || [];
  if (tokens.length) {
    const shown = tokens.slice(0, 6);
    const names = swatchNames(shown);
    pages.push({
      kind: 'palette',
      label: 'Color Palette',
      section: 'Color',
      topic: '3.1',
      page: 4,
      spec: () => ({
        render: 'palette',
        colors: shown.map((t, i) => ({ hex: t.hex, name: names[i] })),
      }),
    });
  }

  /* Typeface ------------------------------------------------------------- */
  if (headingFamily) {
    pages.push({
      kind: 'split',
      label: 'Typeface',
      section: 'Typography',
      topic: '4.1',
      page: 5,
      spec: () => ({
        render: 'split',
        title: 'TYPEFACE',
        columns: 1,
        paragraphs: [[
          typography.pairing.rationale
          || `${headingFamily} is the heading face the site declares in its own type tokens.`,
        ]],
        panel: { light: false, node: typePanel(headingFamily) },
      }),
    });
  }

  /* Weights -------------------------------------------------------------- */
  const weighted = (typography.families || []).filter((f) => f.weights?.length);
  if (weighted.length) {
    const ROLE_ORDER = { heading: 0, body: 0, display: 1, sans: 1, serif: 2, mono: 2 };
    const ordered = [...weighted].sort(
      (a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1) || (b.share || 0) - (a.share || 0),
    );
    pages.push({
      kind: 'weights',
      label: 'Weights',
      section: 'Typography',
      topic: '4.2',
      page: 6,
      spec: () => ({ render: 'weights', rows: ordered.flatMap(expandWeights).slice(0, 4) }),
    });
  }

  /* Type scaling --------------------------------------------------------- */
  const scale = dedupeScale(typography.scale || []);
  if (scale.length) {
    pages.push({
      kind: 'scaling',
      label: 'Type Scaling',
      section: 'Typography',
      topic: '4.3',
      page: 7,
      spec: () => ({
        render: 'scaling',
        rows: scale.slice(0, 5).map((s) => ({
          px: s.px,
          sample: scaleLabel(s.name),
          note: s.rem ? `${s.rem}rem · used ${s.usageCount}x` : `used ${s.usageCount}x`,
        })),
      }),
    });
  }

  // Page numbers are fixed above, but a brand missing an asset leaves a hole.
  // Close them so the running header never claims a page that is not there.
  let next = 2;
  for (const page of pages) {
    if (page.kind === 'cover') continue;
    page.page = next;
    next += 1;
  }

  return pages;
}

/* ── The full document, for when an LLM can write it ────────────────────── */

function fullDeck(guide) {
  const identity = guide.identity || {};
  const logos = guide.logos || {};
  const colors = guide.colors || {};
  const typography = guide.typography || {};
  const voice = guide.voice || {};
  const messaging = guide.messaging || {};
  const narrative = guide.narrative || null;
  const prov = guide.provenance || {};
  const name = brandName(identity);

  const out = [];

  // Section one opens with prose rather than a black plate, and carries the section's
  // own number so the contents list reads "1.0 Introduction" then "1.1 Table of content".
  out.push({
    section: 'intro',
    label: SECTION_LABEL.intro,
    title: 'INTRODUCTION',
    divider: true,
    opener: 'prose',
    spec: () => ({ render: 'intro', columns: introductionColumns(guide) }),
  });

  out.push({
    section: 'intro',
    label: 'Contents',
    title: 'CONTENTS',
    spec: () => ({ render: 'contents' }),
  });

  /* Introduction ------------------------------------------------------- */
  if (identity.description) {
    out.push({
      section: 'intro', label: 'About the brand', title: 'ABOUT THE BRAND',
      spec: () => ({ render: 'statement', text: aboutSentence(identity) }),
    });
  }

  if (messaging.positioning?.text) {
    // Positioning is a statement, not a specimen. This page carries the positioning
    // line and the brand's own tagline, set the way the reference sets its
    // aim-and-vision page.
    const pairs = [{ text: messaging.positioning.text }];
    if (identity.tagline) pairs.push({ text: identity.tagline });

    out.push({
      section: 'intro', label: 'Positioning', title: 'POSITIONING',
      spec: () => ({ render: 'statementPair', pairs }),
    });
  }

  const pillars = messaging.pillars || [];
  if (pillars.length >= 2) {
    out.push({
      section: 'intro', label: 'Message pillars', title: 'MESSAGE PILLARS',
      spec: () => ({
        render: 'rows',
        rows: pillars.slice(0, 4).map((p) => ({
          label: p.name,
          body: pillarEvidence(p),
          note: `Ranked ${p.rank} of ${pillars.length} by term frequency`,
        })),
      }),
    });
  }

  if (voice.descriptors?.length >= 2) {
    out.push({
      section: 'intro', label: 'Tone of voice', title: 'TONE OF VOICE',
      spec: () => ({
        render: 'rows',
        rows: voice.descriptors.slice(0, 4).map((d) => ({
          label: d.axis, body: d.note, note: `Measured as ${d.value}`,
        })),
      }),
    });
  }

  if (narrative?.positioning && narrative?.toneSummary) {
    const aim = aimStatement(narrative.positioning, name);
    if (aim) {
      out.push({
        section: 'intro', label: 'Aim and vision', title: 'AIM AND VISION',
        spec: () => ({
          render: 'statementPair',
          pairs: [
            { text: aim },
            { text: narrative.toneSummary },
          ],
        }),
      });
    }
  }

  /* Logo ---------------------------------------------------------------- */
  if (logos.primary?.url) {
    out.push({
      section: 'logo', label: 'Logomark', title: 'LOGOMARK',
      spec: () => ({
        render: 'split',
        columns: 2,
        paragraphs: [
          [`${name} declares its image assets in the document head. This mark was selected by the extractor and confirmed by fetching the URL back.`],
          [logos.primary.reason || ''],
        ],
        panel: { light: plateIsLight(logos.primary.svgTone), node: logoImage(logos.primary, 'mark') },
      }),
    });
  }

  // Logotype, then the asset register: the order the reference sets them in, and the
  // order that keeps the wordmark next to the mark it belongs with.
  if (name) {
    out.push({
      section: 'logo', label: 'Logotype', title: 'LOGOTYPE',
      spec: () => logotypePageSpec(name, typography),
    });
  }

  const alternates = logos.alternates || [];
  if (alternates.length) {
    out.push({
      section: 'logo', label: 'Asset register', title: 'ASSET REGISTER',
      spec: () => ({
        render: 'rows',
        rows: alternates.slice(0, 4).map((a) => ({
          label: (a.format || 'asset').toUpperCase(),
          monoLabel: true,
          body: a.reason || 'Declared in the document head',
          note: [a.verifiedBy === 'tinyfish-fetch' ? 'fetch verified' : a.verifiedBy, a.declaredSize]
            .filter(Boolean).join(' · '),
        })),
      }),
    });
  }

  /* Color --------------------------------------------------------------- */
  const tokens = colors.tokens || [];
  if (tokens.length) {
    const shown = tokens.slice(0, 6);
    const names = swatchNames(shown);
    out.push({
      section: 'color', label: 'Color palette', title: 'COLOR PALETTE',
      spec: () => ({
        render: 'palette',
        colors: shown.map((t, i) => ({ hex: t.hex, name: names[i] })),
      }),
    });
  }

  const contrast = colors.contrast || [];
  if (contrast.length) {
    out.push({
      section: 'color', label: 'Combinations', title: 'COMBINATIONS',
      spec: () => ({
        render: 'pairs',
        pairs: contrast.slice(0, 6).map((c) => ({
          background: c.background, foreground: c.foreground, ratio: c.ratio,
          label: c.label, use: c.use, sample: sampleFor(c.use),
        })),
      }),
    });
  }

  /* Typography ---------------------------------------------------------- */
  const headingFamily = typography.pairing?.heading;
  if (headingFamily) {
    out.push({
      section: 'type', label: 'Typeface', title: 'TYPEFACE',
      spec: () => ({
        render: 'split',
        columns: 1,
        paragraphs: [[typography.pairing.rationale || `${headingFamily} is the site's heading face.`]],
        panel: { light: false, node: typePanel(headingFamily) },
      }),
    });
  }

  const weighted = (typography.families || []).filter((f) => f.weights?.length);
  if (weighted.length) {
    const ROLE_ORDER = { heading: 0, body: 0, display: 1, sans: 1, serif: 2, mono: 2 };
    const ordered = [...weighted].sort(
      (a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1) || (b.share || 0) - (a.share || 0),
    );
    out.push({
      section: 'type', label: 'Weights', title: 'WEIGHTS',
      spec: () => ({ render: 'weights', rows: ordered.flatMap(expandWeights).slice(0, 4) }),
    });
  }

  const scale = dedupeScale(typography.scale || []);
  if (scale.length) {
    out.push({
      section: 'type', label: 'Type scaling', title: 'TYPE SCALING',
      spec: () => ({
        render: 'scaling',
        rows: scale.slice(0, 5).map((s) => ({
          px: s.px, sample: scaleLabel(s.name),
          note: s.rem ? `${s.rem}rem · used ${s.usageCount}x` : `used ${s.usageCount}x`,
        })),
      }),
    });
  }

  const doRules = voice.do || [];
  if (doRules.length) {
    out.push({
      section: 'type', label: 'Writing in this voice', title: 'WRITING IN THIS VOICE',
      spec: () => ({
        render: 'rows',
        rows: doRules.slice(0, 4).map((r) => ({
          label: 'Do', body: r.instruction, quote: r.evidence, source: r.source,
        })),
      }),
    });
  }

  /* Method -------------------------------------------------------------- */
  if (prov.pagesRead?.length) {
    out.push({
      section: 'method', label: 'Sources read', title: 'SOURCES READ',
      spec: () => ({
        render: 'list',
        items: [
          `${prov.pagesRead.length} pages read through TinyFish Fetch`,
          `${prov.stylesheetsRead?.length || 0} stylesheets read back as raw CSS`,
          `${prov.tinyfish?.totalCalls || 0} TinyFish calls, ${Math.round((prov.tinyfish?.totalMs || 0) / 1000)}s in total`,
          `${voice.sentencesAnalysed || 0} sentences measured for tone`,
          `Input “${guide.input?.given}” resolved to ${identity.url || identity.domain}`,
        ],
      }),
    });
  }

  const confSections = Object.entries(guide.confidence?.bySection || {}).map(([key, value]) => ({
    label: titleCase(key), score: value.score, grade: value.grade,
  }));
  if (confSections.length) {
    out.push({
      section: 'method', label: 'Confidence', title: 'CONFIDENCE',
      spec: () => ({ render: 'confidence', sections: confSections, note: guide.confidence?.basis }),
    });
  }

  return out;
}

/* ── Exported for tests ─────────────────────────────────────────────────── */
// The DOM-bound renderers above cannot run under `node --test`, but these carry the
// judgement calls worth pinning down: how a swatch gets its name, and how a
// variable font axis becomes a list of printable weight stops.

export { swatchNames, weightStops, mix, luminance, inkOn, brandName, scaleLabel, measuredDeck, plateIsLight, introductionColumns, plural, fullDeck, aimStatement };

/* ── Composition ────────────────────────────────────────────────────────── */

/**
 * Compose the deck.
 *
 * @param {object} guide extracted guide
 * @param {{ target?: number }} [opts]
 */
function composeDeck(guide, opts = {}) {
  printedEvidence.clear();

  const hasLlm = Boolean(guide.narrative);
  const requested = Math.max(4, opts.target || 14);

  /* Deterministic: the seven measured pages, in the printed sequence. ------ */
  if (!hasLlm) {
    const pages = measuredDeck(guide);
    const rendered = pages.map((item) => renderMeasuredPage(item, guide));

    return {
      pages: rendered,
      requested: rendered.length,
      delivered: rendered.length,
      mode: 'measured',
      outline: pages.map((p) => ({
        section: p.section || null, number: p.topic, label: p.label, isDivider: false,
      })),
    };
  }

  /* Full document: everything, bounded by the requested length. ----------- */
  const usable = [];
  for (const entry of fullDeck(guide)) {
    let spec = null;
    try {
      spec = entry.spec();
    } catch {
      spec = null;
    }
    if (spec) usable.push({ ...entry, spec });
  }

  // `fullDeck` already emits the contents page, so this pass only adds section openers.
  // A section whose opener is the contents page (or prose) does not also get a plate,
  // because the contents page *is* the opener in the reference.
  const ordered = [];
  for (const sectionKey of SECTION_ORDER) {
    const inSection = usable.filter((e) => e.section === sectionKey);
    if (!inSection.length) continue;

    const openers = inSection.filter((e) => e.spec.render === 'contents' || e.opener === 'prose');
    const rest = inSection.filter((e) => e.spec.render !== 'contents' && e.opener !== 'prose');

    if (!openers.length) {
      ordered.push({
        section: sectionKey, label: SECTION_LABEL[sectionKey],
        title: SECTION_LABEL[sectionKey], divider: true,
      });
    }
    ordered.push(...openers, ...rest);
  }

  const trimmed = trimToBudget(ordered, requested);

  const subCounter = {};
  let page = 0;
  const numbered = trimmed.map((item) => {
    page += 1;
    const major = majorFor(item.section);
    if (item.divider) return { ...item, number: `${major}.0`, page };
    subCounter[item.section] = (subCounter[item.section] || 0) + 1;
    return { ...item, number: `${major}.${subCounter[item.section]}`, page };
  });

  const outline = numbered.map((item) => ({
    section: item.section,
    number: item.number,
    label: item.divider ? SECTION_LABEL[item.section] : item.label,
    isDivider: Boolean(item.divider),
  }));

  const cover = renderCoverPage(guide);
  const rest = numbered.map((item) => renderFullPage(item, outline, guide));

  return {
    pages: [cover, ...rest],
    requested: requested + 1,
    delivered: numbered.length + 1,
    mode: 'full',
    outline: [{ section: null, number: null, label: 'Cover', isCover: true }, ...outline],
  };
}

/** Take content pages in order. A divider is kept only if a content page fits behind it. */
function trimToBudget(ordered, budget) {
  if (ordered.length <= budget) return ordered;

  const kept = [ordered[0]];
  let remaining = budget - 1;

  for (let i = 1; i < ordered.length && remaining > 0; i += 1) {
    const item = ordered[i];
    if (item.divider) {
      if (remaining >= 2) {
        kept.push(item);
        remaining -= 1;
      }
      continue;
    }
    kept.push(item);
    remaining -= 1;
  }
  return kept;
}

/* ── Page construction ──────────────────────────────────────────────────── */

function renderCoverPage(guide) {
  const { page, body } = shell({ bare: true, index: { topic: '', page: '' } });

  const mark = lockupAsset(guide.logos);
  renderCover(body, {
    name: brandName(guide.identity),
    mark: mark
      ? logoImage(mark, mark === guide.logos?.lockup ? 'cover-mark is-lockup' : 'cover-mark', { silent: true })
      : null,
  });
  return page;
}

/** One of the seven measured pages. */
function renderMeasuredPage(item, guide) {
  if (item.kind === 'cover') return renderCoverPage(guide);

  const { page, body } = shell({
    section: item.section,
    subsection: item.label,
    index: { topic: item.topic, page: item.page },
  });

  const renderers = {
    split: renderSplit,
    palette: renderPalette,
    weights: renderWeights,
    scaling: renderScaling,
  };
  // Built once: the spec factories build DOM, so calling it twice would render two
  // copies of every specimen and throw one away.
  const built = item.spec();
  const spec = { ...built, title: item.title || titleCase(item.label).toUpperCase() };
  (renderers[built.render] || ((b) => pageTitle(b, spec.title)))(body, spec);
  return page;
}

/** One page of the full document. */
function renderFullPage(item, outline, guide) {
  if (item.divider) {
    // A written opener stands in for the plate: section one is introduced with prose
    // as the reference does, so it gets the same shell and index but the
    // introduction body rather than a black panel listing the section.
    if (item.opener === 'prose') {
      const { page, body } = shell({
        section: SECTION_LABEL[item.section] || item.section,
        subsection: item.label,
        index: { topic: item.number, page: item.page },
      });
      renderIntro(body, { ...item.spec, title: item.title });
      return page;
    }

    const { page, body } = shell({
      plate: true,
      section: 'Introduction',
      subsection: SECTION_LABEL[item.section],
      index: { topic: item.number, page: item.page },
  });
    const wrap = el('div', 'plate-body');
    wrap.append(el('h2', 't-plate', SECTION_LABEL[item.section].toUpperCase()));

    const list = el('ul', 'plate-list');
    for (const entry of outline) {
      if (entry.section !== item.section || entry.number === item.number) continue;
      const line = el('li');
      line.append(el('span', 'n', entry.number), el('span', '', entry.label));
      list.append(line);
    }
    wrap.append(list);
    body.append(wrap);
    return page;
  }

  const { page, body } = shell({
    section: SECTION_LABEL[item.section] || item.section,
    subsection: item.label,
    index: { topic: item.number, page: item.page },
  });

  const renderers = {
    intro: renderIntro,
    contents: renderContents,
    statement: renderStatement,
    statementPair: renderStatementPair,
    split: renderSplit,
    rows: renderRows,
    palette: renderPalette,
    pairs: renderPairs,
    weights: renderWeights,
    scaling: renderScaling,
    list: renderList,
    confidence: renderConfidence,
  };

  const spec = { ...item.spec, title: item.title };
  const render = renderers[item.spec.render];
  if (render) render(body, spec, outline);
  else pageTitle(body, item.title);

  return page;
}

function renderStatement(body, spec) {
  body.append(el('p', 't-statement', spec.text));
}

function renderStatementPair(body, spec) {
  const wrap = el('div');
  spec.pairs.forEach((pair, i) => {
    if (i > 0) {
      const rule = el('hr', 'page-rule');
      rule.style.margin = '34px 0';
      wrap.append(rule);
    }
    wrap.append(el('p', 't-statement', pair.text));
  });
  body.append(wrap);
}

/** Full-width display title over two columns, unlike `split` where it labels the left column. */
function renderIntro(body, spec) {
  body.append(el('h2', 't-display', spec.title));

  const cols = el('div', 'intro-cols');
  for (const column of spec.columns) {
    const col = el('div');
    for (const text of column) {
      if (text) col.append(el('p', '', text));
    }
    cols.append(col);
  }
  body.append(cols);
}

/** Grouped by section so the column split never orphans a row from its heading. */
function renderContents(body, spec, outline) {
  body.append(el('h2', 't-display', 'TABLE OF CONTENT'));

  const groups = [];
  for (const entry of outline) {
    if (entry.isCover) continue;
    const last = groups[groups.length - 1];
    if (last && last.section === entry.section) last.items.push(entry);
    else groups.push({ section: entry.section, items: [entry] });
  }

  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  let running = 0;
  const cut = groups.findIndex((g) => {
    running += g.items.length;
    return running >= total / 2;
  });
  const columns = [groups.slice(0, Math.max(1, cut + 1)), groups.slice(Math.max(1, cut + 1))];

  const toc = el('div', 'toc');
  for (const column of columns) {
    const block = el('div', 'toc-block');
    for (const group of column) {
      const divider = group.items.find((i) => i.isDivider);
      const head = el('div', 'toc-part is-section');
      head.append(
        el('span', 'n', divider ? divider.number : `${majorFor(group.section)}.0`),
        el('span', '', SECTION_LABEL[group.section] || group.section),
      );
      block.append(head);

      for (const entry of group.items) {
        if (entry.isDivider) continue;
        const row = el('div', 'toc-item');
        row.append(el('span', 'n', entry.number), el('span', '', entry.label));
        block.append(row);
      }
    }
    toc.append(block);
  }
  body.append(toc);
}

/* ── Brand token plumbing ───────────────────────────────────────────────── */

/**
 * The document is always light. Inheriting a dark brand's background would turn the
 * guide into a screenshot of that site, and a print of it into a book of black
 * pages. Only the typeface comes from the brand.
 */
function brandVars(guide) {
  const pairing = guide.typography?.pairing || {};
  return {
    '--face-brand': pairing.heading ? `"${pairing.heading}", var(--face)` : 'var(--face)',
  };
}

/* ── Viewer ────────────────────────────────────────────────────────────────── */

/**
 * Render the pages into a host on a fixed 1200x900 canvas, so one page looks the same
 * on a laptop and a projector and the canvas never reflows. Navigation is left to the
 * caller, since the toolbar also owns things the deck knows nothing about.
 */
export function renderDeck(host, guide, opts = {}) {
  host.replaceChildren();

  const deck = el('div', 'deck');
  const result = composeDeck(guide, opts);

  for (const [key, value] of Object.entries(brandVars(guide))) {
    deck.style.setProperty(key, value);
  }

  /* Viewport ----------------------------------------------------------- */

  const viewport = el('div', 'deck-viewport');
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', 'Brand guide pages');

  const canvas = el('div', 'deck-canvas');
  for (const page of result.pages) canvas.append(page);
  viewport.append(canvas);

  deck.append(viewport);

  host.append(deck);

  /* Fit the fixed canvas ------------------------------------------------ */

  const fit = () => {
    const width = viewport.clientWidth;
    if (!width) return;
    const scale = width / 1200;
    canvas.style.transform = `scale(${scale})`;
    viewport.style.height = `${Math.round(900 * scale)}px`;
  };

  const observer = new ResizeObserver(fit);
  observer.observe(viewport);
  fit();

  /* Navigation --------------------------------------------------------- */

  let current = 0;

  const show = (target) => {
    const wasOnFirst = current === 0;
    const wasOnLast = current === result.pages.length - 1;

    current = Math.max(0, Math.min(result.pages.length - 1, target));

    for (const [i, page] of result.pages.entries()) page.hidden = i !== current;

    // Restart the turn animation by clearing the flag, forcing a reflow, then setting
    // it again. The cheapest way to replay a CSS animation.
    const active = result.pages[current];
    delete active.dataset.enter;
    void active.offsetWidth;
    active.dataset.enter = 'true';

    viewport.setAttribute(
      'aria-label',
      `Brand guide, page ${current + 1} of ${result.pages.length}: ${result.outline[current]?.label || 'page'}`,
    );

    // Only announce an edge once, so a caller polling on every call does not
    // light up the arrows on page two.
    return {
      index: current,
      total: result.pages.length,
      onFirst: current === 0 && !wasOnFirst,
      onLast: current === result.pages.length - 1 && !wasOnLast,
    };
  };

  viewport.tabIndex = 0;
  viewport.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(current - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(current + 1); }
    if (event.key === 'Home') { event.preventDefault(); show(0); }
    if (event.key === 'End') { event.preventDefault(); show(result.pages.length - 1); }
  });

  show(0);

  return {
    show,
    total: result.pages.length,
    outline: result.outline,
    delivered: result.delivered,
    viewport,
  };
}
