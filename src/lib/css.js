/**
 * A small CSS reader. Real stylesheets are minified, alias custom properties
 * through other custom properties, and hide tokens in `@media` blocks, so every
 * reader below matches at any nesting depth rather than unwrapping the file.
 */

/** Strip comments without breaking string literals. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * All custom property declarations: `--name: value;`
 * @returns {Map<string, { value: string, important: boolean }>}
 */
export function parseCustomProperties(css) {
  const props = new Map();
  const re = /(--[\w-]+)\s*:\s*([^;{}]+?)\s*(important\s*)?(?=[;}]|$)/gi;
  let m;
  while ((m = re.exec(css))) {
    const name = m[1].toLowerCase();
    const value = m[2].trim();
    // Later definitions win, matching the cascade closely enough for our use.
    props.set(name, { value, important: Boolean(m[3]) });
  }
  return props;
}

/**
 * Resolve `--a: var(--b)` chains to a terminal value.
 * @param {Map<string,{value:string}>} props
 * @param {string} name
 * @param {number} [maxDepth]
 * @returns {string|null}
 */
export function resolveCustomProperty(props, name, maxDepth = 8) {
  const seen = new Set();
  let current = props.get(name)?.value ?? null;
  let depth = 0;

  while (current && depth < maxDepth) {
    const varMatch = current.match(/^\s*var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/i);
    if (!varMatch) break;
    const next = varMatch[1].toLowerCase();
    if (seen.has(next)) break;
    seen.add(next);
    const resolved = props.get(next);
    if (!resolved) {
      // Fall back to the fallback value if the referenced token is missing.
      current = varMatch[2] ? varMatch[2].trim() : null;
      break;
    }
    current = resolved.value;
    depth += 1;
  }
  return current ? current.trim() : null;
}

/** All @font-face blocks. */
export function parseFontFaces(css) {
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const family = pick(body, /font-family\s*:\s*([^;}]+)/i);
    const weight = pick(body, /font-weight\s*:\s*([^;}]+)/i);
    const style = pick(body, /font-style\s*:\s*([^;}]+)/i);
    const display = pick(body, /font-display\s*:\s*([^;}]+)/i);
    const stretch = pick(body, /font-stretch\s*:\s*([^;}]+)/i);
    const src = pick(body, /src\s*:\s*([^}]+)/i);

    if (!family) continue;
    faces.push({
      family: cleanQuoted(family),
      weight: weight ? cleanQuoted(weight) : '400',
      style: style ? cleanQuoted(style) : 'normal',
      display: display ? cleanQuoted(display) : null,
      stretch: stretch ? cleanQuoted(stretch) : null,
      formats: extractFormats(src),
      isGoogleFont: /fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny\.net|typekit\.com/i.test(src || ''),
      isVariable: /font-weight\s*:\s*\d{2,3}\s+(\d{2,3})/i.test(body) || /wght|wdth|opsz/i.test(src || ''),
    });
  }
  return faces;
}

/** Every `font-family:` value in the stylesheet, frequency counted by caller. */
export function parseFontFamilyDeclarations(css) {
  const values = [];
  const re = /font-family\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = re.exec(css))) values.push(m[1].trim());
  return values;
}

/** Split a font stack into individual family names. */
export function splitFontStack(stack) {
  if (!stack) return [];
  return stack
    .split(',')
    .map((part) => cleanQuoted(part.trim()))
    .filter((part) => part && !/^var\(/i.test(part));
}

/** Every colour literal in the stylesheet with how many times it appears. */
export function findColourOccurrences(css) {
  const counts = new Map();
  const record = (raw) => {
    const key = raw.trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) record(m[0]);
  for (const m of css.matchAll(/\brgba?\(\s*[\d.%,\s/]+\s*\)/gi)) record(m[0]);
  for (const m of css.matchAll(/\bhsla?\(\s*[\d.%,\s/deg-]+\s*\)/gi)) record(m[0]);

  return counts;
}

/** `clamp()` / `rem` steps, the raw material for a type scale. */
export function parseTypeSizes(css) {
  const sizes = [];
  for (const m of css.matchAll(/font-size\s*:\s*([^;{}]+)/gi)) {
    sizes.push({ value: m[1].trim(), clamp: /clamp\(/i.test(m[1]) });
  }
  return sizes;
}

/** Leading / letter-spacing character of the brand's type system. */
export function parseTypeDetail(css) {
  let letterSpacing = 0;
  let letterSpacingCount = 0;
  let lineHeightValues = [];
  let textTransformCount = 0;

  for (const m of css.matchAll(/letter-spacing\s*:\s*([^;{}]+)/gi)) {
    const value = m[1].trim().toLowerCase();
    const n = parseFloat(value);
    if (Number.isFinite(n) && value.endsWith('em')) {
      letterSpacing += n;
      letterSpacingCount += 1;
    }
  }
  for (const m of css.matchAll(/line-height\s*:\s*([^;{}]+)/gi)) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n > 0.8 && n < 3) lineHeightValues.push(n);
  }
  textTransformCount = (css.match(/text-transform\s*:\s*uppercase/gi) || []).length;

  return {
    letterSpacingEm: letterSpacingCount ? Number((letterSpacing / letterSpacingCount).toFixed(3)) : 0,
    lineHeight: lineHeightValues.length
      ? Number((lineHeightValues.reduce((a, b) => a + b, 0) / lineHeightValues.length).toFixed(2))
      : null,
    uppercaseCount: textTransformCount,
  };
}

function pick(body, re) {
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

function cleanQuoted(value) {
  return String(value).trim().replace(/^["']|["']$/g, '').trim();
}

function extractFormats(src) {
  if (!src) return [];
  const formats = [];
  for (const m of src.matchAll(/format\(\s*["']?([\w-]+)["']?\s*\)/gi)) formats.push(m[1].toLowerCase());
  return formats;
}