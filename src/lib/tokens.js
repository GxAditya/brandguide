/**
 * Design-token serialisers: how a brand guide becomes CSS, a Tailwind theme, a
 * Style Dictionary set or a Figma Variables collection. The renderers run unchanged
 * in the browser, so a token exported from the UI is byte-identical to one fetched
 * from the API.
 */

import { parseColor } from './colour.js';

/** Assemble the token tree from the extracted colour and typography sections. */
export function buildDesignTokens({ colors = {}, typography = {} }) {
  return {
    colour: buildColourTokens(colors),
    typography: buildTypographyTokens(typography),
  };
}

const ROLE_META = new Set(['declaredThemeColor', 'inferred', 'shared', 'darkSurface']);

function buildColourTokens(colors) {
  const out = {};
  for (const [role, hex] of Object.entries(colors.roles || {})) {
    if (ROLE_META.has(role)) continue;
    if (typeof hex !== 'string' || !hex.startsWith('#')) continue;
    out[role] = { value: hex, declared: !(colors.roles.inferred || []).includes(role) };
  }
  for (const [step, hex] of Object.entries(colors.neutralRamp || {})) {
    out[`neutral-${step}`] = { value: hex, declared: false };
  }
  return out;
}

function buildTypographyTokens(typography) {
  const out = {};
  const pair = typography?.pairing || {};

  if (pair.heading) out['font-heading'] = { value: quoteFont(pair.heading) };
  if (pair.body) out['font-body'] = { value: quoteFont(pair.body) };
  if (pair.mono) out['font-mono'] = { value: quoteFont(pair.mono) };

  for (const step of typography?.scale || []) {
    out[`size-${step.name}`] = { value: `${step.px}px` };
  }
  if (typography?.detail?.lineHeight) out['leading-body'] = { value: String(typography.detail.lineHeight) };
  if (typography?.detail?.letterSpacingEm) out['tracking-default'] = { value: `${typography.detail.letterSpacingEm}em` };

  return out;
}

function quoteFont(family) {
  return /\s/.test(family) ? `"${family}"` : family;
}

/** `:root` custom properties. */
export function toCss(tokens, meta = {}) {
  const lines = [
    '/*',
    meta.name ? ` * ${meta.name} design tokens` : ' * Design tokens',
    meta.url ? ` * Extracted from ${meta.url} via TinyFish Fetch on ${new Date().toISOString().slice(0, 10)}` : null,
    ' * Re-run BrandKit to refresh — brand sites change.',
    ' */',
    ':root {',
  ]
    .filter((l) => l !== null)
    .join('\n')
    .split('\n');

  for (const [name, token] of Object.entries(tokens.colour || {})) {
    lines.push(`  --color-${name}: ${token.value};${token.declared ? '' : '  /* inferred by BrandKit */'}`);
  }
  for (const [name, token] of Object.entries(tokens.typography || {})) {
    lines.push(`  --${name}: ${token.value};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

/** A `tailwind.config` theme block. */
export function toTailwind(tokens) {
  const colors = {};
  const neutral = {};
  for (const [name, token] of Object.entries(tokens.colour || {})) {
    if (name.startsWith('neutral-')) neutral[name.slice(8)] = token.value;
    else colors[name] = token.value;
  }

  const fontFamily = {};
  if (tokens.typography?.['font-heading']) fontFamily.heading = tokens.typography['font-heading'].value;
  if (tokens.typography?.['font-body']) fontFamily.body = tokens.typography['font-body'].value;
  if (tokens.typography?.['font-mono']) fontFamily.mono = tokens.typography['font-mono'].value;

  const fontSize = {};
  const lineHeight = {};
  for (const [name, token] of Object.entries(tokens.typography || {})) {
    if (name.startsWith('size-')) fontSize[name.slice(5)] = token.value;
    if (name.startsWith('leading-')) lineHeight[name.slice(7)] = token.value;
  }

  return {
    theme: {
      extend: {
        colors: Object.keys(neutral).length ? { ...colors, neutral } : colors,
        fontFamily: Object.keys(fontFamily).length ? fontFamily : undefined,
        fontSize: Object.keys(fontSize).length ? fontSize : undefined,
        lineHeight: Object.keys(lineHeight).length ? lineHeight : undefined,
      },
    },
  };
}

/** Style Dictionary v3 shape. */
export function toStyleDictionary(tokens) {
  const properties = {};

  for (const [name, token] of Object.entries(tokens.colour || {})) {
    properties[`color.${name}`] = {
      value: token.value,
      ...(token.declared ? {} : { comment: 'inferred by BrandKit, not declared by the site' }),
    };
  }
  for (const [name, token] of Object.entries(tokens.typography || {})) {
    const group = name.startsWith('font-') ? 'font' : name.startsWith('size-') ? 'size' : name.startsWith('leading-') ? 'leading' : 'tracking';
    properties[`typography.${group}.${name.split('-').pop()}`] = { value: token.value };
  }

  return { properties };
}

/** Figma Variables collection, importable via Tokens Studio or the REST API. */
export function toFigmaVariables(tokens) {
  const variables = [];

  for (const [name, token] of Object.entries(tokens.colour || {})) {
    const rgb = parseColor(token.value);
    if (!rgb) continue;
    variables.push({
      id: `color-${name}`,
      name: `color/${name}`,
      resolvedType: 'COLOR',
      description: token.declared
        ? 'Declared by the site\'s own CSS or metadata'
        : 'Inferred by BrandKit from the site\'s palette',
      valuesByMode: {
        Default: {
          r: Number((rgb.r / 255).toFixed(4)),
          g: Number((rgb.g / 255).toFixed(4)),
          b: Number((rgb.b / 255).toFixed(4)),
          a: 1,
        },
      },
      hexValue: token.value,
    });
  }

  for (const [name, token] of Object.entries(tokens.typography || {})) {
    variables.push({
      id: `string-${name}`,
      name: name.replace('-', '/'),
      resolvedType: 'STRING',
      valuesByMode: { Default: token.value },
    });
  }

  return {
    name: 'BrandKit',
    modes: ['Default'],
    variableCount: variables.length,
    variables,
    _note: 'Import via Tokens Studio, or POST these to the Figma Variables REST API. Every variable records the hex it was extracted as.',
  };
}