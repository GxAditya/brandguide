/**
 * Output formats.
 *
 * The point of a structured brand guide is that something else can consume it,
 * so these renderers are deliberately literal: no clever transformations that
 * would need undoing on the other side.
 */

import { buildDesignTokens, toCss, toTailwind, toStyleDictionary, toFigmaVariables } from '../lib/tokens.js';

export const FORMATS = ['json', 'markdown', 'css', 'tailwind', 'styledictionary', 'figma', 'svg'];

/**
 * @param {string} format
 * @param {object} guide
 * @returns {{ body: string, contentType: string, filename: string }}
 */
export function render(format, guide) {
  // The four endpoints name the same section differently: a brand guide has
  // `colors`, the identity payload has `colours` (British, to match the rest of
  // that document). Accept either so `?format=` works on every endpoint.
  const colors = guide.colors || guide.colours || {};
  const typography = guide.typography || {};
  const meta = {
    name: guide.identity?.name || guide.name,
    url: guide.identity?.url || guide.url,
  };

  const tokens = buildDesignTokens({
    colors,
    typography,
    shape: guide.shape || {},
    spacing: guide.spacing || null,
  });

  switch (format) {
    case 'markdown':
      return { body: toMarkdown(guide), contentType: 'text/markdown; charset=utf-8', filename: `${slug(guide)}-brand-guide.md` };
    case 'css':
      return { body: toCss(tokens, meta), contentType: 'text/css; charset=utf-8', filename: `${slug(guide)}-tokens.css` };
    case 'tailwind':
      return {
        body: `// ${guide.identity?.name || 'BrandKit'} theme\n// Extracted live via TinyFish Fetch. Paste into tailwind.config.\n\nmodule.exports = ${JSON.stringify(toTailwind(tokens), null, 2)}\n`,
        contentType: 'application/javascript; charset=utf-8',
        filename: `${slug(guide)}-tailwind.js`,
      };
    case 'styledictionary':
      return {
        body: JSON.stringify(toStyleDictionary(tokens), null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${slug(guide)}-tokens.json`,
      };
    case 'figma':
      return {
        body: JSON.stringify(toFigmaVariables(tokens), null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${slug(guide)}-figma-variables.json`,
      };
    case 'svg':
      return { body: toSwatchSvg(guide), contentType: 'image/svg+xml; charset=utf-8', filename: `${slug(guide)}-palette.svg` };
    case 'json':
    default:
      return { body: JSON.stringify(guide, null, 2), contentType: 'application/json; charset=utf-8', filename: `${slug(guide)}-brand-guide.json` };
  }
}

function slug(guide) {
  const raw = guide.identity?.domain || guide.identity?.name || guide.domain || guide.url || guide.subject || 'brand';
  try {
    // A full URL makes a better filename stem than a long path.
    const host = new URL(String(raw).includes('//') ? String(raw) : `https://${raw}`).hostname;
    return host.replace(/^www\./, '').replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return String(raw).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'brand';
  }
}

// --- markdown --------------------------------------------------------------

/** Deck-ready: swatch tables, a specimen block, and a provenance footnote. */
export function toMarkdown(guide) {
  const { identity, colors, typography, logos, voice, messaging, confidence, provenance } = guide;
  const out = [];

  out.push(`# ${identity.name} — brand guide`);
  out.push('');
  out.push(`> ${identity.tagline || identity.description || ''}`.trim());
  out.push('');
  out.push(`**Source** <${identity.url}> · **extracted** ${new Date(guide.generatedAt).toISOString().slice(0, 10)} · **confidence** ${Math.round((confidence?.overall || 0) * 100)}%`);
  out.push('');

  if (logos?.primary) {
    out.push('## Logo');
    out.push('');
    out.push(`- **Primary** — ${logos.primary.format.toUpperCase()}, ${logos.primary.type}`);
    out.push(`  - ${logos.primary.url}`);
    out.push(`  - ${logos.primary.reason}`);
    if (logos.alternates?.length) {
      out.push('- **Alternates**');
      for (const alt of logos.alternates) out.push(`  - ${alt.format.toUpperCase()} — ${alt.url}`);
    }
    out.push('');
  }

  out.push('## Colour');
  out.push('');
  out.push('| Role | Hex | RGB | HSL | Source |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const [role, hex] of Object.entries(colors?.roles || {})) {
    if (typeof hex !== 'string' || !hex.startsWith('#')) continue;
    const token = colors.tokens.find((t) => t.hex === hex);
    const marked = colors.roles.inferred?.includes(role) ? 'inferred' : token?.declared ? token.tokens[0] || 'declared' : 'derived';
    out.push(`| ${role} | \`${hex}\` | ${token?.rgb || '—'} | ${token?.hsl || '—'} | ${marked} |`);
  }
  out.push('');

  if (colors?.contrast?.length) {
    out.push('### Contrast');
    out.push('');
    out.push('| Pair | Ratio | WCAG |');
    out.push('| --- | --- | --- |');
    for (const c of colors.contrast) out.push(`| ${c.use} — \`${c.foreground}\` on \`${c.background}\` | ${c.ratio}:1 | ${c.label} |`);
    out.push('');
  }

  out.push('## Typography');
  out.push('');
  out.push(`**Headings** ${typography?.pairing?.heading || '—'} · **Body** ${typography?.pairing?.body || '—'} · **Mono** ${typography?.pairing?.mono || '—'}`);
  out.push('');
  out.push(`> ${typography?.pairing?.rationale || ''}`);
  out.push('');
  out.push('| Family | Role | Type | Weights | Declared in |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const f of typography?.families || []) {
    out.push(`| ${f.family} | ${f.role || '—'} | ${f.kind} | ${f.weights?.join(', ') || '—'} | ${f.declaredIn} |`);
  }
  out.push('');

  if (voice?.ok) {
    out.push('## Tone of voice');
    out.push('');
    out.push(`| Axis | Reads as |`);
    out.push('| --- | --- |');
    for (const d of voice.descriptors || []) out.push(`| ${d.axis} | **${d.value}** — ${d.note} |`);
    out.push('');
    if (voice.summary) {
      out.push(voice.summary);
      out.push('');
    }

    if (voice.do?.length) {
      out.push('### Do');
      for (const item of voice.do) {
        out.push(`- **${item.instruction}** — ${item.because}`);
        if (item.evidence) out.push(`  > "${item.evidence}" — ${item.source}`);
      }
      out.push('');
    }
    if (voice.dont?.length) {
      out.push('### Don\'t');
      for (const item of voice.dont) {
        out.push(`- **${item.instruction}** — ${item.because}`);
        if (item.example) out.push(`  > ${item.example}`);
      }
      out.push('');
    }
  }

  if (messaging?.taglines?.length) {
    out.push('## Messaging');
    out.push('');
    if (messaging.positioning) {
      out.push(`**Positioning** — ${messaging.positioning.text}`);
      out.push('');
    }
    out.push('### Tagline candidates');
    for (const t of messaging.taglines) out.push(`- "${t.text}" _(${t.kind}, from ${t.source})_`);
    out.push('');
    if (messaging.pillars?.length) {
      out.push('### Message pillars');
      for (const p of messaging.pillars) {
        out.push(`- **${p.name}** — ${p.terms.slice(0, 4).join(', ')}`);
        for (const s of p.support || []) out.push(`  > "${s.text}" — ${s.source}`);
      }
      out.push('');
    }
  }

  if (guide.narrative?.toneSummary) {
    out.push('## Read of the brand');
    out.push('');
    out.push(`*${guide.narrative.toneSummary}*`);
    out.push('');
    if (guide.narrative.pillars?.length) {
      for (const p of guide.narrative.pillars) {
        out.push(`- **${p.name}** — ${p.claim}${p.evidence ? ` _"${p.evidence}"_` : ''}`);
      }
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('### How this was extracted');
  out.push('');
  out.push('Every value above came from the live site through TinyFish:');
  out.push('');
  for (const method of provenance?.methods || []) out.push(`- ${method}`);
  out.push('');
  out.push(
    `${provenance?.tinyfish?.totalCalls || 0} TinyFish calls across ${provenance?.pagesRead?.length || 0} page(s) and ${provenance?.stylesheetsRead?.length || 0} stylesheet(s).`,
  );
  out.push('');
  out.push(`*Generated by BrandKit. Source: ${identity.url}. Re-run to refresh — brand sites change.*`);
  out.push('');

  return out.join('\n');
}


/** A single-file swatch sheet, downloadable straight into a deck. */
export function toSwatchSvg(guide) {
  const colors = guide.colors || { tokens: [], roles: {} };
  const tokens = colors.tokens?.length ? colors.tokens : Object.entries(colors.roles || {}).filter(([, v]) => typeof v === 'string').map(([role, hex]) => ({ hex, name: role }));

  const W = 960;
  const pad = 32;
  const sw = 168;
  const gap = 16;
  const headerH = 96;
  const cardH = 116;
  const perRow = Math.floor((W - pad * 2 + gap) / (sw + gap));
  const rows = Math.ceil(tokens.length / perRow);
  const H = headerH + rows * (cardH + gap) + pad + 40;

  const name = escapeXml(guide.identity?.name || 'Brand palette');
  const dark = colors.roles?.darkSurface;
  const bg = dark ? '#0b0b0c' : '#ffffff';
  const fg = dark ? '#f5f5f6' : '#141416';
  const muted = dark ? '#9a9aa0' : '#6b6b72';

  const cards = tokens
    .map((t, i) => {
      const x = pad + (i % perRow) * (sw + gap);
      const y = headerH + Math.floor(i / perRow) * (cardH + gap);
      const textOn = isLight(t.hex);
      const label = textOn ? '#141416' : '#ffffff';
      return `<g>
    <rect x="${x}" y="${y}" width="${sw}" height="${cardH}" rx="12" fill="${escapeXml(t.hex)}"/>
    <text x="${x + 14}" y="${y + cardH - 34}" font-family="ui-sans-serif,-apple-system,Segoe UI,sans-serif" font-size="15" font-weight="600" fill="${label}">${escapeXml(t.hex)}</text>
    <text x="${x + 14}" y="${y + cardH - 14}" font-family="ui-sans-serif,-apple-system,Segoe UI,sans-serif" font-size="12" fill="${label}" opacity="0.72">${escapeXml(capitalise(t.name || t.role || 'colour'))}</text>
  </g>`;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${name} colour palette">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <text x="${pad}" y="52" font-family="ui-sans-serif,-apple-system,Segoe UI,sans-serif" font-size="26" font-weight="700" fill="${fg}">${name}</text>
  <text x="${pad}" y="76" font-family="ui-sans-serif,-apple-system,Segoe UI,sans-serif" font-size="13" fill="${muted}">Extracted live from ${escapeXml(guide.identity?.url || '')} via TinyFish Fetch · ${new Date(guide.generatedAt).toISOString().slice(0, 10)}</text>
  ${cards}
</svg>`;
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return true;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function capitalise(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}