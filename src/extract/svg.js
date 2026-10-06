/**
 * SVG logo source.
 *
 * A logo loaded through `<img>` cannot inherit from the page, and most design
 * systems ship one `currentColor` file meant to work on light and dark. Read as text
 * and inlined, it resolves against the page instead. Inlining remote markup is a
 * script-injection risk, so everything executable or external is stripped here.
 */

const MAX_SVG_CHARS = 120_000;

/** Elements that can execute, embed a document, or pull in outside content. */
const FORBIDDEN_ELEMENTS = [
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video',
  'animate', 'animatetransform', 'animatemotion', 'set', 'handler', 'listener',
];

/**
 * Strip everything executable or external from SVG source. The root must be `<svg>`,
 * not merely present somewhere in the input: a logo request the origin dislikes gets
 * a 200 with an HTML page full of inline icons, and lifting one of those out would put
 * an untrusted mark on the cover.
 *
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

  // External references: only data URIs and bare fragment ids survive, so a
  // `<use href="https://elsewhere/x.svg#y">` cannot pull in a remote file.
  markup = markup.replace(/\s(?:xlink:)?href\s*=\s*"([^"]*)"/gi, (match, value) => {
    const v = String(value).trim();
    if (v.startsWith('#') || /^data:image\//i.test(v)) return match;
    return ' href=""';
  });

  // Paint servers are a second way to reference something outside the file.
  // `url(#gradient)` is defined in this document and is fine; `url(https://…)`
  // is a remote fetch, and `none` is the safe neutral.
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

  // A viewBox is required, not merely a width. Without one the drawing has no
  // coordinate system of its own, so the deck cannot scale it to the plate: a
  // 16x16 favicon with width and height but no viewBox would lay out at 16x16
  // inside a 200px box and read as a speck.
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

/** Decides the plate a mark is shown on: a white mark on a white page is invisible. */
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
 * Read the source of the verified SVG candidates so the deck can inline them.
 * Only SVGs are fetched: a raster logo needs no inlining.
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
