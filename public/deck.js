/**
 * The deck: composes a paged brand guide from an extracted guide object.
 *
 * Two modes, and the difference is the whole point of this module.
 *
 * DETERMINISTIC (no LLM configured). Seven pages, and only seven:
 *
 *   Cover · Logomark · Logotype · Color palette · Typeface · Weights · Type scaling
 *
 * Every one of those is a *measurement*: a verified asset URL, a resolved hex,
 * an @font-face declaration, a size the site actually uses. Nothing on them is
 * written, because a brand cannot be summarised from a hex value. The prose on
 * those pages is assembled from measured fields and is deliberately factual
 * ("this asset was fetched back and confirmed"), never brand narrative.
 *
 * LLM (configured). The full document, including the pages that need writing:
 * the introduction, about the brand, positioning, values, tone, application. The
 * page budget from the UI drives how much is asked for.
 *
 * Two placements are rules rather than preferences, because getting either wrong
 * puts a thing on a page it does not belong to:
 *   - Section one opens with a written introduction, not a black plate.
 *   - The wordmark is typeset on the logotype page, in the logo section, and on
 *     no other page in either deck.
 *
 * The rule throughout: a page is only emitted if it can be filled truthfully,
 * and a shortfall is stated rather than padded.
 *
 * Page anatomy follows the reference deck: a running header, a rule, then
 * content on a landscape 4:3 canvas.
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

/** The four tint strips, mixed toward whichever end keeps them distinct. */
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

/** Join with commas and a final "and", for readable factual sentences. */
function listPhrase(parts, conjunction = 'and') {
  const items = parts.filter(Boolean);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

/* ── The page shell ─────────────────────────────────────────────────────── */

/**
 * A page: running header, rule, then body.
 *
 * The reference deck fills column three with the template author's attribution.
 * That is not ours to print, and there is nothing to replace it with that a
 * reader of a brand guide needs, so the column is kept for its spacing and left
 * empty. Columns one and two hold the topic number, the page number and the
 * section, which is what actually navigates the document.
 */
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

/**
 * The cover: a full-bleed plate carrying the lockup.
 *
 * Left-aligned at the same 36% the section dividers use, which is what makes it
 * read as part of the same system rather than a separate splash.
 */
/**
 * The logo a cover should show.
 *
 * `logos.lockup` is the mark plus wordmark, which is what a cover is for.
 * `logos.primary` is deliberately SVG-first and is usually the app icon, so it is
 * the fallback rather than the first choice.
 *
 * The Logotype page does not use this. A logotype is the wordmark on its own, so
 * that page sets the name; showing the lockup there would repeat the mark from
 * the page before it.
 */
function lockupAsset(logos) {
  return logos?.lockup || logos?.primary || null;
}

function renderCover(body, spec) {
  const wrap = el('div', 'cover-lockup');

  if (spec.mark) wrap.append(spec.mark);

  // The brand's own capitalisation. "tailwindcss" must not be set as
  // "TAILWIND CSS"; the reference reads uppercase only because that is how its
  // own wordmark happens to be drawn.
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

    // Two side-by-side value columns, as in the reference: CMYK on the left,
    // RGB on the right. One interleaved stack would be twice as tall for no gain.
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
 * A logo node.
 *
 * SVG source that the extractor read and sanitised is inlined rather than
 * loaded through `src`. That is not an optimisation: an `<img>` cannot inherit
 * from the page, so a `fill="currentColor"` logo renders as a flat black shape
 * and a brand's cyan mark arrives greyscale. Inlined, `currentColor` resolves
 * against the wrapper and the real colours come through.
 *
 * `inherit` assets have no colour of their own, so the wrapper supplies one.
 * The markup is parsed with DOMParser and adopted node by node, never assigned
 * to innerHTML, so nothing in it can execute.
 *
 * `silent` removes the node on failure instead of leaving a message. The cover
 * uses it because a stale asset URL there would otherwise print "logo asset did
 * not load" directly above the brand name.
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
      // A parse error yields a <parsererror> root rather than throwing.
      if (svg && svg.nodeName.toLowerCase() === 'svg') {
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-hidden', 'true');
        holder.append(document.importNode(svg, true));
        return holder;
      }
    } catch {
      // Fall through to the URL below.
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
 * Whether the plate a mark sits on should be light.
 *
 * A white mark on a white page is invisible, which is the same class of bug as
 * the greyscale one: right asset, wrong surface. The extractor measures the
 * mark's own colours, so the surface can follow the asset.
 *
 * The rule is deliberately one-sided. The plate flips to light only when the
 * source was read and measured dark, because that is the case that would
 * otherwise be invisible. Everything else keeps the dark plate the reference
 * uses:
 *
 * - `light`   a white mark, so it needs the dark plate. The reference case.
 * - `inherit` the mark has no colour of its own and takes `color` from the
 *             plate, which the panel already sets to the paper tone. Both work;
 *             the dark plate is the reference look.
 * - `unknown` a raster, or a source that carried no readable fill. No evidence
 *             either way, so the reference default stands.
 */
function plateIsLight(tone) {
  return tone === 'dark';
}

/**
 * The brand's real name, never the URL it was reached at.
 *
 * The extractor resolves this from the site's own metadata, so "linear.app"
 * becomes "Linear". `identity.source.basis` records where it came from, which is
 * worth surfacing when the only source available was the domain itself.
 */
function brandName(identity) {
  return String(identity?.name || identity?.domain || 'Unknown brand').trim();
}

/**
 * The logotype page's opening sentence.
 *
 * The extractor's rationale usually opens by naming the family ("A single
 * family, Inter Variable, does all the work"), so blindly prefixing "The
 * wordmark is set in Inter Variable." says the same words twice in one line.
 */
function logotypeSentence(family, rationale) {
  if (!family) return 'No heading typeface was declared by this site, so no logotype can be set from the extraction.';
  if (!rationale) return `The wordmark is set in ${family}.`;

  const opensWithFamily = rationale.toLowerCase().startsWith(`${family.toLowerCase()},`);
  if (opensWithFamily) return `The wordmark is set in ${rationale}`;
  return `The wordmark is set in ${family}. ${rationale}`;
}

/**
 * What the logotype page shows.
 *
 * A logotype is the wordmark on its own, so the name is typeset in the brand's
 * heading face rather than cropped out of a lockup file. That is also what the
 * reference does: its logotype page is set type inside a bordered box, not an
 * image. Showing the full lockup here would just repeat the mark from the
 * previous page.
 */
function wordmarkNode(name) {
  const node = el('p', 'specimen-sample', name);
  node.style.fontSize = '86px';
  return node;
}

/**
 * The logotype page, shared by both decks.
 *
 * One definition, because the wordmark belongs to exactly one place in a brand
 * guide: the logo section, on the page after the logomark. When the two decks
 * each described it, the positioning page grew a wordmark panel of its own,
 * because a panel was wanted there and the wordmark was the panel.
 *
 * A logotype is the wordmark on its own, so the name is typeset in the brand's
 * heading face rather than cropped out of a lockup file. That is also what the
 * reference does: its logotype page is set type inside a bordered box, not an
 * image. Showing the full lockup here would just repeat the mark from the
 * previous page.
 *
 * @param {string} name the brand's own name
 * @param {object} typography the extracted type
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
 * The weight stops worth printing for one family.
 *
 * A `@font-face` with `font-weight: 100 900` is a variable axis, not a list of
 * two weights, and taking the first three digits of it would label every row
 * "Thin". A declared range is sampled at the stops a brand guide documents,
 * while a list of discrete weights is taken as given.
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

/**
 * The brand's own name for a colour, taken from the CSS custom property that
 * declared it. The extractor labels #7070FF "royalblue" because that is the
 * nearest CSS named colour in Lab space, which is a measurement artefact; the
 * site itself calls it `--color-link-primary`.
 */
function fromTokenName(token) {
  const raw = token.tokens?.find((name) => typeof name === 'string');
  if (!raw) return '';

  const parts = raw.replace(/^--/, '').split('-').filter(Boolean);
  while (parts.length > 1 && TOKEN_NAMESPACES.has(parts[0].toLowerCase())) parts.shift();

  const words = parts.slice(0, 3).map((word) => word.toLowerCase());
  if (words.length > 2 && /colou?rs?$/.test(words[words.length - 1])) words.pop();

  return titleCase(words.join(' '));
}

/**
 * Name each swatch, avoiding repeats on one spread. Roles first, then the CSS
 * token name wherever the role is missing, too generic, or already taken.
 */
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

/**
 * Pick the supporting line for a pillar, skipping one already used above it.
 * Two pillars can share the same top headline, and a page that quotes the same
 * sentence twice reads as a bug rather than as evidence.
 */
function pillarEvidence(pillar) {
  const quote = (pillar.support || []).find((s) => s?.text && !printedEvidence.has(s.text));
  if (quote) {
    printedEvidence.add(quote.text);
    return quote.text;
  }
  return `Appears on ${Math.round((pillar.prevalence || 0) * 100)}% of the pages read.`;
}

/**
 * The opening sentence of the full document.
 *
 * A meta description very often opens with the company's own name, so blindly
 * prefixing it produces "GOV.UK, the best place to find government services"
 * twice on one line.
 */
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
 * Fold a positioning line into the aim statement.
 *
 * The narration usually answers with a whole sentence that already names the
 * brand — "Linear is a purpose-built product development system…" — so prefixing
 * "Our aim is" to it printed "Our aim is linear is a purpose-built…", and adding
 * a full stop to a line that already ended in one printed two. Both were visible
 * in a real run, so the prefix is only applied when the line does not already
 * stand as a sentence about the brand.
 *
 * @param {string} positioning
 * @param {string} name
 * @returns {string|null} the statement, or null when there is nothing to say
 */
function aimStatement(positioning, name) {
  const text = String(positioning || '').trim().replace(/[.\s]+$/, '');
  if (!text) return null;

  const standsAlone = name && text.toLowerCase().startsWith(`${name.toLowerCase()} `);
  return standsAlone ? `${text}.` : `Our aim is ${lowerFirst(text)}.`;
}

/**
 * The two columns of the introduction.
 *
 * The reference opens with a page of prose about what the guidelines are for, and
 * this is that page. It cannot be assembled from a hex value, so it is written
 * from the two things that are actually true at this point in the pipeline: what
 * the extraction measured, and what the narration layer said about the voice. It
 * asserts no value, ambition or claim about the brand that the extraction did not
 * produce, and it copies nothing from the reference — the reference's own text
 * describes its author's brand, not this one.
 *
 * Both columns are always several sentences. A one-line introduction is not a
 * summary of anything, and an empty one is worse than leaving the page out.
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

  // The narration layer's read on the voice, which is the one thing on this page
  // that is written rather than measured, and belongs to the introduction.
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
 * The only pages a brand can be documented with without writing anything.
 *
 * Every field below is read from the live site. The prose is assembled from
 * those fields and stays descriptive of the extraction rather than the brand,
 * because "this asset was fetched back and confirmed" is true and "this
 * symbolises our commitment to precision" would be invention.
 *
 * Topic numbers are fixed to the reference deck so the pages line up with the
 * printed sequence: 2.1, 2.2, 3.1, 4.1, 4.2, 4.3.
 */
function measuredDeck(guide) {
  const identity = guide.identity || {};
  const logos = guide.logos || {};
  const colors = guide.colors || {};
  const typography = guide.typography || {};
  const name = brandName(identity);

  const pages = [];
  /** Pages that could not be built, and why. Reported rather than padded over. */
  const skipped = [];

  const skip = (label, why) => skipped.push(`${label} (${why})`);

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

  /* Anything above that produced no page is named here, so a six-page deck
     explains itself instead of looking like a rendering failure. */
  const built = new Set(pages.map((p) => p.label));
  if (!built.has('Logomark')) skip('Logomark', 'no logo asset could be verified');
  if (!built.has('Logotype')) skip('Logotype', 'no brand name could be resolved');
  if (!built.has('Color Palette')) skip('Color Palette', 'no colour tokens were readable');
  if (!built.has('Typeface')) skip('Typeface', 'no heading typeface was declared');
  if (!built.has('Weights')) skip('Weights', 'no explicit font weights were declared');
  if (!built.has('Type Scaling')) skip('Type Scaling', 'no type sizes were measurable');

  // Page numbers are fixed above, but a brand missing an asset leaves a hole.
  // Close them so the running header never claims a page that is not there.
  let next = 2;
  for (const page of pages) {
    if (page.kind === 'cover') continue;
    page.page = next;
    next += 1;
  }

  pages.skipped = skipped;
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

  /*
   * Section one opens with a written page rather than a black plate.
   *
   * The reference spends its front matter on prose and reserves the plate for the
   * sections after it, so this page is marked as an opener: it carries the
   * section's own number instead of taking a sub-number, which is what lets the
   * contents list read "1.0 Introduction" followed by "1.1 Table of content".
   */
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
    /*
     * Positioning is a statement, not a specimen.
     *
     * This page used to carry a wordmark panel, which put the logotype on a page
     * in the introduction and left the logo section without one. A wordmark
     * belongs to the logotype page and nowhere else, so this page is now the
     * positioning line and the brand's own tagline, set as statements the way the
     * reference sets its aim-and-vision page.
     */
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

  // Logotype, then the asset register: the order the reference sets them in, and
  // the order that keeps the wordmark next to the mark it belongs with.
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
// The DOM-bound renderers above cannot run under `node --test`, but these carry
// the judgement calls worth pinning down: how a swatch gets its name, and how a
// variable font axis becomes a list of printable weight stops.

export { swatchNames, weightStops, mix, luminance, inkOn, brandName, scaleLabel, measuredDeck, plateIsLight, introductionColumns, logotypePageSpec, plural, fullDeck, aimStatement };

/* ── Composition ────────────────────────────────────────────────────────── */

/**
 * Compose the deck.
 *
 * @param {object} guide extracted guide
 * @param {{ target?: number }} [opts]
 */
export function composeDeck(guide, opts = {}) {
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

  // `fullDeck` already emits the contents page, so this pass only adds the
  // section openers. A section that opens with its contents page does not also
  // get a plate, because in the reference the contents page *is* the opener:
  // page one lists 1.1 Table of content under the 1.0 Introduction heading, with
  // no plate in front of it.
  //
  // A written opener counts as one. The introduction page is prose rather than a
  // plate, but it holds the section number in the same way, so it is grouped with
  // the contents page instead of being numbered as content of its own.
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

/**
 * Keep the contents page, then take content pages in order. A divider is only
 * kept when at least one content page fits behind it, so the document never
 * opens a section it cannot fill.
 */
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
  // Built once. The spec factories build DOM, so calling it twice would render
  // two copies of every specimen and throw one away.
  const built = item.spec();
  const spec = { ...built, title: item.title || titleCase(item.label).toUpperCase() };
  (renderers[built.render] || ((b) => pageTitle(b, spec.title)))(body, spec);
  return page;
}

/** One page of the full document. */
function renderFullPage(item, outline, guide) {
  if (item.divider) {
    // A written opener stands in for the plate: section one is introduced with
    // prose, as the reference does, so it gets the same shell and index but the
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

/**
 * The introduction.
 *
 * A full-width display title over two columns of body copy. Distinct from
 * `split`, where the title holds the left column beside the text: on this page the
 * title heads the whole spread rather than labelling the copy next to it, which
 * is why it needed its own renderer instead of a flag on `split`.
 */
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

/**
 * Contents.
 *
 * Grouped into runs by section so the two-column split never orphans a row from
 * the heading it belongs to.
 */
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
 * CSS custom properties for the deck.
 *
 * The document is always light. A brand guide that inherits a dark brand's
 * background stops being a document and becomes a screenshot of that brand's
 * site, and a print of it comes out as a book of black pages. So the paper and
 * the ink are fixed here and never taken from the brand.
 *
 * What the brand does change is the type it is set in, and the colour of every
 * swatch, plate and specimen drawn on the page.
 */
export function brandVars(guide) {
  const pairing = guide.typography?.pairing || {};
  return {
    '--face-brand': pairing.heading ? `"${pairing.heading}", var(--face)` : 'var(--face)',
  };
}

/* ── Viewer ────────────────────────────────────────────────────────────────── */

/**
 * A stepper on a fixed canvas, so one page looks the same on a laptop and on a
 * projector. The canvas never reflows: 1200x900 scaled to fit its container.
 *
 * Navigation is a native `<select>` rather than a row of jump pills. At seven
 * pages a pill row is friendlier; at the twenty-four the full document can
 * reach it wraps to three lines and stops being a toolbar.
 *
 * @param {HTMLElement} host
 * @param {object} guide
 * @param {{ target?: number }} [opts]
 */
/**
 * Render the guide pages into a host, and hand back a controller for them.
 *
 * The deck is only the pages. The toolbar that sits above it belongs to the
 * caller, because it mixes the deck's own navigation with things the deck knows
 * nothing about, such as what the guide can be exported as. So this returns
 * `show`, the outline, and the page count, and lets the caller decide what the
 * controls around them look like.
 *
 * composeDeck no longer gathers commentary about the extraction either. It used
 * to hand back notes about what it could not document, and they were rendered
 * under the deck; nothing displays them now, so they are not assembled either.
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

    // Restart the turn animation by clearing the flag, forcing a reflow, then
    // setting it again. The cheapest way to replay a CSS animation.
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
