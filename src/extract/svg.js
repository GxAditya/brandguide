/**
 * SVG logo source.
 *
 * A logo loaded through `<img src="…svg">` cannot inherit anything from the
 * page, and a large share of real brand SVGs are built to inherit:
 * `fill="currentColor"` is how most design systems ship a single logo file that
 * works on light and dark backgrounds. Loaded as an image, `currentColor`
 * resolves against the SVG's own default, so a cyan-and-white Tailwind mark
 * renders as a flat black shape. That is the whole bug: not a filter, not a bad
 * asset, just an image boundary doing what images do.
 *
 * The fix is to read the source and inline it, so `currentColor` resolves
 * against the page. That is the same trick the CSS reader already relies on,
 * since a stylesheet read back as text is how the palette works at all.
 *
 * Inlining remote markup is a script-injection risk, so everything is stripped
 * before it leaves this module: scripts, event handlers, external references
 * and anything else that can execute or phone home.
 */

const MAX_SVG_CHARS = 120_000;

/** Elements that can execute, embed a document, or pull in outside content. */
const FORBIDDEN_ELEMENTS = [
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video',
  'animate', 'animatetransform', 'animatemotion', 'set', 'handler', 'listener',
];

/**
 * Strip everything executable or external from SVG source.
 *
 * The input must be an SVG *document*, not merely something containing an
 * `<svg>` element. Logo URLs fail over: a request that the origin does not like
 * gets a 200 with an HTML page instead of the asset, and that page is full of
 * inline icons. Lifting one of those out would put an unrelated, untrusted mark
 * on the cover under the brand's name. So the first real tag has to be `<svg>`.
 *
 * @param {string} source
 * @returns {string} safe markup, or '' if nothing usable survived
 */
export function sanitiseSvg(source) {
  const text = String(source || '').slice(0, MAX_SVG_CHARS);
  if (!/<svg[\s>]/i.test(text)) return '';

  let markup = text
    .replace(/<!--[\s\S]*?-->/g, '')
    // <?xml …?> and any stray doctype, which can pull an external DTD.
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '');

  // The root element decides whether this is an SVG document or a web page.
  const root = /<\s*([a-z][a-z0-9:-]*)/i.exec(markup);
  if (!root || root[1].toLowerCase() !== 'svg') return '';

  for (const tag of FORBIDDEN_ELEMENTS) {
    markup = markup.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // Self-closing form, e.g. <set … />
    markup = markup.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // Inline event handlers.
  markup = markup.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  markup = markup.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  markup = markup.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

  /*
   * External references. Only data URIs and bare fragment ids are kept, so a
   * `<use href="https://elsewhere/x.svg#y">` cannot pull in a remote file.
   */
  markup = markup.replace(/\s(?:xlink:)?href\s*=\s*"([^"]*)"/gi, (match, value) => {
    const v = String(value).trim();
    if (v.startsWith('#') || /^data:image\//i.test(v)) return match;
    return ' href=""';
  });

  /*
   * Paint servers, which are a second way to reference something outside the
   * file. `url(#gradient)` is a gradient defined in this same document and is
   * fine; `url(https://elsewhere/g.svg#g)` is a remote fetch. A `fill` of
   * `none` is the safe neutral.
   */
  markup = markup.replace(
    /\s(fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end)\s*=\s*"url\(([^)]*)\)"(?:\s+([a-z-]+)\s*=\s*"([^"]*)")?/gi,
    (match, prop, ref) => {
      const target = String(ref).trim();
      if (target.startsWith('#')) return match;
      return ` ${prop}="none"`;
    },
  );

  // `javascript:` in any style value.
  markup = markup.replace(/javascript\s*:/gi, '');

  if (!/<svg[\s>]/i.test(markup)) return '';

  /*
   * A viewBox is required, not merely a width. Without one the drawing has no
   * coordinate system of its own, so the deck cannot scale it to the plate: a
   * 16x16 favicon with width and height but no viewBox would be laid out at
   * 16x16 inside a 200px box and read as a speck. `sanitiseSvg` guarantees the
   * artwork can be fitted, which is what the renderer relies on.
   */
  if (!/\sviewBox\s*=\s*["'][^"']+["']/i.test(markup)) return '';

  return markup;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

/**
 * Relative luminance of a CSS colour, or null when it cannot be read.
 * 0 is black, 1 is white.
 */
export function colourLuminance(value) {
  const raw = String(value || '').trim();

  const hex = HEX.exec(raw);
  if (hex) {
    const n = hex[1].length === 3
      ? hex[1].split('').map((c) => c + c).join('')
      : hex[1];
    const num = parseInt(n, 16);
    return relativeLuminance((num >> 16) & 255, (num >> 8) & 255, num & 255);
  }

  const rgb = RGB.exec(raw);
  if (rgb) {
    return relativeLuminance(+rgb[1], +rgb[2], +rgb[3]);
  }

  return null;
}

function relativeLuminance(r, g, b) {
  const channel = (v) => {
    const s = Math.max(0, Math.min(255, v)) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Whether a mark is drawn light or dark, and whether it inherits its colour.
 *
 * This decides the plate it is shown on. A white mark on a white page is
 * invisible, which is the same class of bug as the greyscale one: correct
 * asset, wrong surface.
 *
 * @returns {{ tone: 'light'|'dark'|'inherit', swatches: number }}
 */
export function svgTone(markup) {
  const text = String(markup || '');

  const values = [];
  for (const m of text.matchAll(/(?:fill|stop-color|solidcolor|flood-color)\s*=\s*"([^"]+)"/gi)) {
    values.push(m[1]);
  }
  // `style="fill:#38bdf8"` is common and would otherwise be missed entirely.
  for (const m of text.matchAll(/(?:fill|stop-color)\s*:\s*([^;"']+)/gi)) {
    values.push(m[1]);
  }

  const lumas = values
    // "none" and url(#gradient) carry no colour of their own.
    .filter((v) => !/^(none|url\(|inherit|transparent)/i.test(String(v).trim()))
    .map(colourLuminance)
    .filter((v) => v !== null && Number.isFinite(v));

  const inherits = /currentColor|context-fill|context-stroke/i.test(text);

  if (!lumas.length) return { tone: inherits ? 'inherit' : 'unknown', swatches: 0 };

  const mean = lumas.reduce((sum, v) => sum + v, 0) / lumas.length;
  return { tone: mean > 0.55 ? 'light' : 'dark', swatches: lumas.length };
}

/**
 * Read the source of the SVG candidates so the deck can inline them.
 *
 * Only SVGs are fetched: a raster logo needs no inlining, and an SVG only has
 * to be inlined if it actually inherits or would be invisible on a light plate.
 *
 * @param {import('../tinyfish/client.js').TinyFishClient} client
 * @param {object[]} candidates already verified, mutated in place
 * @returns {Promise<{ inlined: number }>}
 */
export async function attachSvgSource(client, candidates) {
  const targets = (candidates || [])
    .filter((c) => c.format === 'svg')
    .slice(0, 4);

  if (!targets.length) return { inlined: 0 };

  let response;
  try {
    response = await client.fetchContent(targets.map((c) => c.url), {
      format: 'markdown',
      perUrlTimeoutMs: 20_000,
      purpose:
        'Read the raw SVG source of a verified brand logo so its colours and gradients can be preserved when it is re-rendered.',
      label: `svg × ${targets.length}`,
    });
  } catch {
    // A missing source is not fatal: the deck falls back to the URL as an image.
    return { inlined: 0 };
  }

  let inlined = 0;
  for (const page of response.results || []) {
    const source = page.text || '';
    if (!source.trim()) continue;

    const markup = sanitiseSvg(source);
    if (!markup) continue;

    const url = page.final_url || page.url;
    const target = targets.find((c) => c.url === url || c.url === page.url);
    if (!target) continue;

    const { tone, swatches } = svgTone(markup);
    target.svg = markup;
    target.svgTone = tone;
    target.svgSwatches = swatches;
    inlined += 1;
  }

  return { inlined };
}

export { FORBIDDEN_ELEMENTS, MAX_SVG_CHARS };
