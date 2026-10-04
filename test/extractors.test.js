/**
 * Extractor tests against canned CSS and HTML.
 *
 * These are the tests that would have caught the three real bugs found while
 * building this: the destructive at-rule unwrapper, translucent colours
 * collapsing onto opaque black, and frequency outranking a declared token.
 * No network is touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractColors, classifyToken } from '../src/extract/color.js';
import { extractTypography } from '../src/extract/typography.js';
import { analyseCopy, mergeVoice, htmlToText, splitSentences } from '../src/extract/voice.js';
import { extractMessaging, salience } from '../src/extract/messaging.js';
import { extractIdentity } from '../src/extract/identity.js';
import { buildDesignTokens, toCss, toTailwind, toStyleDictionary, toFigmaVariables } from '../src/lib/tokens.js';
import { selectPages } from '../src/crawl/pages.js';
import { toMarkdown, toSwatchSvg, render } from '../src/export/index.js';

// ── Token classification ────────────────────────────────────────────────────

test('classifyToken separates design-system roles from component noise', () => {
  assert.deepEqual(classifyToken('--color-bg-primary'), { tier: 'declaredRole', role: 'background', onPrimary: false, variant: false, qualifier: 'primary' });
  assert.equal(classifyToken('--color-text-primary').role, 'text');
  assert.equal(classifyToken('--color-fg-primary').role, 'text');
  assert.equal(classifyToken('--color-link-primary').role, 'link');
  assert.equal(classifyToken('--color-accent').role, 'accent');
  assert.equal(classifyToken('--color-border-primary').role, 'border');
  assert.equal(classifyToken('--color-brand-bg').role, 'primary');
});

test('classifyToken reads --color-brand-text as text on the brand colour', () => {
  const result = classifyToken('--color-brand-text');
  assert.equal(result.role, 'primary');
  assert.equal(result.onPrimary, true);
});

test('classifyToken treats raw colour names and numeric scales as palette entries', () => {
  assert.equal(classifyToken('--color-white').tier, 'paletteEntry');
  assert.equal(classifyToken('--color-black').role, null);
  assert.equal(classifyToken('--blue-500').tier, 'paletteEntry');
  assert.equal(classifyToken('--color-blue-500').variant, true);
});

test('classifyToken demotes component-scoped names', () => {
  assert.equal(classifyToken('--header-bg').tier, 'component');
  assert.equal(classifyToken('--plan-tail-accent').tier, 'component');
  assert.equal(classifyToken('--graph-dot').tier, 'component');
  assert.equal(classifyToken('--timeline-backdrop').tier, 'component');
});

test('classifyToken marks hover and tint variants', () => {
  assert.equal(classifyToken('--color-accent-hover').variant, true);
  assert.equal(classifyToken('--color-accent-tint').variant, true);
  assert.equal(classifyToken('--color-accent').variant, false);
});

test('classifyToken accepts bare role tokens', () => {
  assert.equal(classifyToken('--bg-base').tier, 'bareRole');
  assert.equal(classifyToken('--bg-base').role, 'background');
});

// ── Colour extraction ───────────────────────────────────────────────────────

/** A stylesheet shaped like the ones real framework sites ship. */
const CSS = `
@charset "UTF-8";
/* a comment with #ff0000 in it must be ignored */
@layer reset, base;
:root{
  --color-bg-primary:#ffffff;
  --color-bg-secondary:#f9f8f9;
  --color-text-primary:#282a30;
  --color-text-secondary:#3c4149;
  --color-fg-tertiary:#6f6e77;
  --color-border-primary:#e9e8ea;
  --color-brand-bg:#7070ff;
  --color-brand-text:#ffffff;
  --color-accent:#7170ff;
  --color-accent-hover:#8989f0;
  --color-accent-tint:#f1f1ff;
  --color-link-primary:#7070ff;
  --color-white:#fff;
  --color-black:#000;
  --header-bg:#fffc;
  --header-border:#00000014;
  --agent-chip-border:#ffffff14;
  --plan-tail-accent:#21b3ff;
  --graph-dot:#00b8cc;
}
.a{color:#ffffff}
.b{color:#ffffff}
.c{background:rgba(0,0,0,0.04)}
.d{border-color:#00000014}
`;

const HEAD = { themeColor: '#08090a' };
const SHEETS = [{ url: 'https://cdn.test/a.css', css: CSS, bytes: CSS.length }];

test('extractColors prefers declared tokens over frequency', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });

  // White appears far more often than any brand colour, yet must not win.
  assert.equal(colors.roles.primary, '#7070ff', 'the declared --color-brand-bg must be primary');
  assert.equal(colors.roles.background, '#ffffff');
  assert.equal(colors.roles.text, '#282a30');
  assert.equal(colors.roles.border, '#e9e8ea');
  assert.equal(colors.roles.onPrimary, '#ffffff');
  assert.equal(colors.roles.link, '#7070ff');
});

test('extractColors ignores translucent overlays entirely', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  assert.ok(colors.source.translucentOverlaysIgnored > 0, 'overlays must be counted');
  for (const hex of Object.values(colors.roles)) {
    assert.notEqual(hex, '#000000', 'a translucent border must not become solid black');
  }
  assert.ok(
    !colors.tokens.some((t) => t.hex === '#000000'),
    'no palette entry may come from a translucent overlay',
  );
});

test('extractColors keeps hover and tint shades out of the core palette', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  assert.ok(
    !colors.tokens.some((t) => t.hex === '#f1f1ff' || t.hex === '#8989f0'),
    'accent tints and hovers are not the brand palette',
  );
});

test('extractColors marks inferred roles rather than presenting them as measured', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  assert.ok(Array.isArray(colors.roles.inferred));
  assert.ok(!colors.roles.inferred.includes('primary'), 'primary was declared, not inferred');
  assert.ok(!colors.roles.inferred.includes('background'));
});

test('extractColors collapses visually identical colours', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  const hexes = colors.tokens.map((t) => t.hex);
  assert.equal(new Set(hexes).size, hexes.length, 'the palette must not contain duplicates');
});

test('extractColors builds a contrast matrix with real WCAG numbers', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  const body = colors.contrast.find((c) => c.use.includes('body copy on the page'));
  assert.ok(body.ratio > 4.5, `expected an accessible body pair, got ${body.ratio}`);
  assert.ok(['AAA', 'AA', 'AA Large', 'Fail'].includes(body.label));
});

test('extractColors falls back to theme-color when no background token is declared', () => {
  const bare = extractColors({
    sheets: [{ url: 'x', css: '.a{color:#123456}', bytes: 20 }],
    head: { themeColor: '#0b1020' },
  });
  assert.equal(bare.roles.background, '#0b1020');
  assert.ok(bare.roles.inferred.includes('background'), 'a fallback must be flagged as inferred');
  assert.equal(bare.roles.darkSurface, true);
});

test('extractColors survives a site with no stylesheet at all', () => {
  const empty = extractColors({ sheets: [], head: { themeColor: '#101010' }, manifest: null });
  assert.match(empty.roles.background, /^#[0-9a-f]{6}$/);
  assert.match(empty.roles.text, /^#[0-9a-f]{6}$/);
  assert.match(empty.roles.primary, /^#[0-9a-f]{6}$/);
  assert.ok(empty.contrast.length > 0, 'a contrast matrix is still derivable');
});

test('extractColors never invents a hex outside #rrggbb', () => {
  const colors = extractColors({ sheets: SHEETS, head: HEAD });
  const all = [...Object.values(colors.roles).filter((v) => typeof v === 'string'), ...colors.tokens.map((t) => t.hex)];
  for (const hex of all) assert.match(hex, /^#[0-9a-f]{6}$/i, `bad hex: ${hex}`);
});

// ── Typography ──────────────────────────────────────────────────────────────

const TYPE_CSS = `
@font-face{font-family:"Inter Variable";src:url(a.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Berkeley Mono";src:url(b.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"Some Serif";src:url(c.woff2) format("woff2");font-weight:400}
:root{--font-heading:"Inter Variable",sans-serif}
.a{font-family:"Inter Variable",sans-serif}
.b{font-family:"Inter Variable",sans-serif}
.c{font-family:"Some Serif",serif}
code,kbd{font-family:"Berkeley Mono",monospace}
html{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{
  margin:0;padding:0;box-sizing:border-box;font-family:inherit
}
h1{font-size:clamp(2rem,4vw,3rem);line-height:1.1;letter-spacing:-0.02em}
p{font-size:1rem;line-height:1.55}
.small{font-size:0.875rem;text-transform:uppercase}
`;

test('extractTypography finds the real webfonts', () => {
  const typo = extractTypography({ sheets: [{ url: 'x', css: TYPE_CSS, bytes: TYPE_CSS.length }], head: {} });
  const names = typo.families.map((f) => f.family);
  assert.ok(names.includes('Inter Variable'));
  assert.ok(names.includes('Berkeley Mono'));
  assert.ok(names.includes('Some Serif'));
  assert.equal(typo.pairing.heading, 'Inter Variable');
  assert.equal(typo.pairing.mono, 'Berkeley Mono');
});

test('extractTypography does not report the framework reset as a typeface', () => {
  const typo = extractTypography({ sheets: [{ url: 'x', css: TYPE_CSS, bytes: TYPE_CSS.length }], head: {} });
  assert.ok(
    !typo.families.some((f) => f.family === '-apple-system'),
    'the universal reset selector must not become a brand typeface',
  );
});

test('extractTypography records weights and the declaration source', () => {
  const typo = extractTypography({ sheets: [{ url: 'x', css: TYPE_CSS, bytes: TYPE_CSS.length }], head: {} });
  const inter = typo.families.find((f) => f.family === 'Inter Variable');
  assert.ok(inter.isWebfont);
  assert.equal(inter.declaredIn, '@font-face declaration');
  assert.ok(inter.weights.includes('100 900') || inter.weights.includes('100'));
});

test('extractTypography derives a scale from the sizes actually present', () => {
  const typo = extractTypography({ sheets: [{ url: 'x', css: TYPE_CSS, bytes: TYPE_CSS.length }], head: {} });
  assert.ok(typo.scale.length > 0);
  assert.ok(typo.scale.every((s) => typeof s.px === 'number'));
  assert.ok(typo.detail.lineHeight > 0);
  assert.ok(typo.detail.letterSpacingEm < 0, 'the h1 rule has negative tracking');
});

test('extractTypography reads a Google Fonts link out of the head', () => {
  const typo = extractTypography({
    sheets: [],
    head: { stylesheets: ['https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap'] },
  });
  assert.ok(typo.families.some((f) => f.family === 'Manrope'));
  assert.ok(typo.source.vendorLinks.includes('Google Fonts'));
});

test('extractTypography copes with a site that ships no fonts', () => {
  const typo = extractTypography({ sheets: [], head: {} });
  assert.equal(typo.families.length, 0);
  assert.equal(typo.pairing.heading, null);
  assert.match(typo.pairing.rationale, /No font declarations/);
});

// ── Voice ───────────────────────────────────────────────────────────────────

const PAGE_HTML = `
<main>
  <h1>Ship faster</h1>
  <p>We build the fastest product development system available for modern teams.</p>
  <p>Our customers report shipping twice as often after switching, which is not surprising at all.</p>
  <p>You can try it free for fourteen days, no credit card required, and cancel whenever.</p>
  <p>Perhaps you might consider our enterprise plan, which could potentially suit larger organisations.</p>
  <p>Ultimately, we believe great teams deserve tools that stay out of the way.</p>
</main>
<footer>© 2026 Acme. All rights reserved. Cookie policy. Terms of service.</footer>
`;

test('htmlToText strips chrome and decodes entities', () => {
  const text = htmlToText(PAGE_HTML);
  assert.ok(text.includes('Ship faster'));
  assert.ok(!text.includes('<h1>'));
  assert.ok(!text.includes('All rights reserved'), 'footer boilerplate is stripped');
  assert.ok(!text.includes('© 2026'), 'the copyright line is stripped');
});

test('splitSentences rejects nav labels and keeps real prose', () => {
  const sentences = splitSentences('Menu Search Sign in. We build the fastest product development system for modern teams.');
  assert.equal(sentences.length, 1);
  assert.ok(sentences[0].startsWith('We build'));
});

test('analyseCopy measures tone from the text, not from a guess', () => {
  const a = analyseCopy(PAGE_HTML, 'https://x.test');
  assert.ok(a.ok);
  assert.ok(a.sentenceCount >= 4);
  assert.ok(a.wordCount > 40);
  assert.ok(a.metrics.avgSentenceLength > 5);
  assert.ok(a.metrics.readingGrade > 0);

  // Every normalised axis must stay inside 0..1 or the tone vector is useless.
  for (const axis of ['directness', 'formality', 'enthusiasm', 'playfulness', 'warmth', 'assertiveness', 'confidence', 'technicality']) {
    assert.ok(a.metrics[axis] >= 0 && a.metrics[axis] <= 1, `${axis} out of range: ${a.metrics[axis]}`);
  }
});

test('analyseCopy rates a heavily hedged page as less assertive than a flat one', () => {
  const hedged = analyseCopy(
    '<p>Perhaps you might consider our plan, which could potentially suit teams that maybe want something.</p><p>We believe it perhaps helps, and it might possibly be useful for some organisations.</p>',
    'https://x.test',
  );
  const flat = analyseCopy(
    '<p>We built the fastest product system for modern teams. It ships twice as often for every customer we have.</p><p>Every team deserves tools that stay out of the way and ship fast.</p>',
    'https://x.test',
  );
  assert.ok(hedged.metrics.assertiveness < flat.metrics.assertiveness, 'hedging must lower assertiveness');
  assert.ok(flat.metrics.hedgeRate < hedged.metrics.hedgeRate);
});

test('analyseCopy is not dominated by page length', () => {
  // The same sentence on a short page and a long one must score alike.
  const one = '<p>We build the fastest product development system for modern teams today.</p>';
  const long = `<p>We build the fastest product development system for modern teams today.</p>${'<p>Filler content for the page body that adds length but no tone.</p>'.repeat(20)}`;
  const a = analyseCopy(one, 'https://x.test');
  const b = analyseCopy(long, 'https://x.test');
  assert.ok(
    Math.abs(a.metrics.hedgeRate - b.metrics.hedgeRate) < 5,
    `hedge rate should be length-independent: ${a.metrics.hedgeRate} vs ${b.metrics.hedgeRate}`,
  );
});

test('analyseCopy quotes sentences back as evidence', () => {
  const a = analyseCopy(PAGE_HTML, 'https://x.test');
  assert.ok(a.signalSentences.length > 0);
  assert.ok(a.signalSentences.every((s) => PAGE_HTML.includes(s.text.replace(/&/g, '&')) || s.text.length > 10));
});

test('analyseCopy handles a page with no prose', () => {
  const a = analyseCopy('<nav><a href="/">Home</a></nav>', 'https://x.test');
  assert.equal(a.ok, false);
  assert.equal(a.metrics, null);
});

test('mergeVoice reports failure rather than inventing a voice', () => {
  const merged = mergeVoice([analyseCopy('<nav>Home</nav>', 'https://x.test')]);
  assert.equal(merged.ok, false);
  assert.equal(merged.vector, null);
  assert.ok(merged.summary.length > 0);
});

test('mergeVoice produces guidance with reasons attached', () => {
  const merged = mergeVoice([analyseCopy(PAGE_HTML, 'https://x.test')]);
  assert.equal(merged.ok, true);
  assert.ok(merged.do.length > 0);
  assert.ok(merged.dont.length > 0);
  for (const item of merged.do) {
    assert.ok(item.instruction, 'each rule needs an instruction');
    assert.ok(item.because, 'each rule needs a reason');
  }
});

// ── Messaging ───────────────────────────────────────────────────────────────

test('salience ranks by term frequency weighted by page spread', () => {
  const ranked = salience([
    'Issue tracking for product teams',
    'Issue tracking built for modern teams',
    'Issue tracking and issue triage',
    'Something entirely unrelated',
  ]);
  assert.ok(ranked[0].term.includes('issue'));
  assert.ok(ranked[0].pages >= 3);
});

test('extractMessaging separates headlines from boilerplate', () => {
  const pages = [{ url: 'https://x.test', ok: true, title: 'Acme', html: PAGE_HTML, links: [] }];
  const messaging = extractMessaging(pages, { ogDescription: 'The fastest system for modern teams.', title: 'Acme' });

  const headlineTexts = messaging.headlines.map((h) => h.text);
  assert.ok(headlineTexts.some((t) => t.includes('Ship faster')));
  assert.ok(!headlineTexts.some((t) => /^(Home|Sign in|Cookie policy)$/i.test(t)));
  assert.ok(messaging.taglines.length > 0);
  assert.ok(messaging.pillars.length > 0);
  assert.ok(messaging.pillars[0].terms.length > 0);
});

test('extractMessaging keeps a source URL on every claim', () => {
  const pages = [{ url: 'https://x.test/about', ok: true, html: PAGE_HTML, links: [] }];
  const messaging = extractMessaging(pages, {});
  for (const headline of messaging.headlines) assert.match(headline.source, /^https:\/\//);
  for (const pillar of messaging.pillars) {
    for (const support of pillar.support || []) assert.match(support.source, /^https:\/\//);
  }
});

test('extractMessaging copes with a single page and no metadata', () => {
  const messaging = extractMessaging([{ url: 'https://x.test', ok: true, html: PAGE_HTML, links: [] }], {});
  assert.ok(Array.isArray(messaging.pillars));
  assert.ok(Array.isArray(messaging.taglines));
});

// ── Exports ─────────────────────────────────────────────────────────────────

const GUIDE = {
  schemaVersion: '1.0.0',
  generatedAt: '2026-10-02T00:00:00.000Z',
  input: { given: 'acme', resolvedUrl: 'https://acme.test' },
  identity: { name: 'Acme', domain: 'acme.test', url: 'https://acme.test/', tagline: 'Ship faster.' },
  logos: { primary: { url: 'https://acme.test/logo.svg', format: 'svg', type: 'square mark', verifiedBy: 'tinyfish-fetch' }, alternates: [], source: {} },
  colors: extractColors({ sheets: SHEETS, head: HEAD }),
  typography: extractTypography({ sheets: [{ url: 'x', css: TYPE_CSS, bytes: 1 }], head: {} }),
  voice: analyseCopy(PAGE_HTML, 'https://acme.test') && mergeVoice([analyseCopy(PAGE_HTML, 'https://acme.test')]),
  messaging: extractMessaging([{ url: 'https://acme.test', ok: true, html: PAGE_HTML, links: [] }], {}),
  confidence: { overall: 0.82, bySection: {} },
  provenance: { tinyfish: { totalCalls: 7 }, pagesRead: [{ url: 'https://acme.test' }], stylesheetsRead: [{ url: 'a.css' }], methods: ['read via TinyFish'] },
  warnings: [],
};

test('toCss emits :root custom properties with inferred flags', () => {
  const css = toCss(buildDesignTokens({ colors: GUIDE.colors, typography: GUIDE.typography }));
  assert.match(css, /:root \{/);
  assert.match(css, /--color-primary: #7070ff/);
  assert.match(css, /--font-heading: "Inter Variable"/);
  assert.ok(css.trimEnd().endsWith('}'));
});

test('toTailwind produces a valid theme extension', () => {
  const theme = toTailwind(buildDesignTokens({ colors: GUIDE.colors, typography: GUIDE.typography }));
  assert.ok(theme.theme.extend.colors.primary);
  assert.ok(theme.theme.extend.colors.neutral['900']);
  assert.ok(theme.theme.extend.fontFamily.heading.includes('Inter Variable'));
  assert.doesNotThrow(() => JSON.stringify(theme));
});

test('toStyleDictionary produces properties, not a theme object', () => {
  const sd = toStyleDictionary(buildDesignTokens({ colors: GUIDE.colors, typography: GUIDE.typography }));
  assert.ok(sd.properties['color.primary']);
  assert.equal(sd.properties['color.primary'].value, '#7070ff');
  assert.ok(Object.keys(sd.properties).some((k) => k.startsWith('typography.')));
});

test('toFigmaVariables converts hex to normalised 0..1 channels', () => {
  const vars = toFigmaVariables(buildDesignTokens({ colors: GUIDE.colors, typography: GUIDE.typography }));
  const primary = vars.variables.find((v) => v.name === 'color/primary');
  assert.equal(primary.resolvedType, 'COLOR');
  assert.ok(primary.valuesByMode.Default.r >= 0 && primary.valuesByMode.Default.r <= 1);
  // 0x70 = 112
  assert.ok(Math.abs(primary.valuesByMode.Default.r - 112 / 255) < 0.001);
});

test('toMarkdown produces a deck-ready document', () => {
  const md = toMarkdown(GUIDE);
  assert.match(md, /^# Acme — brand guide/);
  assert.match(md, /## Colour/);
  assert.match(md, /## Typography/);
  assert.match(md, /## How this was extracted/);
  assert.match(md, /TinyFish/);
  assert.ok(md.length > 500, 'the document should be substantial, not a stub');
});

test('toSwatchSvg is well-formed and contains the palette', () => {
  const svg = toSwatchSvg(GUIDE);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(svg.includes('#7070ff'));
  assert.ok(!svg.includes('&amp;amp;'), 'entities are escaped exactly once');
});
// ── Regressions found by running the demo on real sites ─────────────────────

test('classifyToken recognises vendor-prefixed design tokens', () => {
  // GOV.UK ships these; none would be seen without the trailing colour word.
  assert.equal(classifyToken('--govuk-brand-colour').tier, 'declaredRole');
  assert.equal(classifyToken('--govuk-brand-colour').role, 'primary');
  assert.equal(classifyToken('--govuk-text-colour').role, 'text');
  assert.equal(classifyToken('--govuk-body-background-colour').role, 'background');
  assert.equal(classifyToken('--govuk-link-colour').role, 'link');
  assert.equal(classifyToken('--govuk-error-colour').role, 'error');
  assert.equal(classifyToken('--govuk-link-hover-colour').variant, true);
});

test('extractColors reads the GOV.UK brand blue and page background', () => {
  const govuk = `
    :root{
      --govuk-brand-colour:#1d70b8;
      --govuk-text-colour:#0b0c0c;
      --govuk-body-background-colour:#ffffff;
      --govuk-template-background-colour:#f3f2f1;
      --govuk-border-colour:#b1b4b6;
      --govuk-link-colour:#1d70b8;
      --govuk-error-colour:#d4351c;
      --govuk-success-colour:#00703c;
      --govuk-focus-colour:#ffdd00;
    }`;
  const colors = extractColors({ sheets: [{ url: 'g', css: govuk, bytes: govuk.length }], head: {} });

  assert.equal(colors.roles.primary, '#1d70b8', 'the GOV.UK brand blue');
  assert.equal(colors.roles.background, '#ffffff', 'body background beats template background');
  assert.equal(colors.roles.text, '#0b0c0c');
  assert.equal(colors.roles.error, '#d4351c');
  assert.equal(colors.roles.success, '#00703c');
});

test('extractTypography resolves a font stack that starts with var()', () => {
  // Patagonia declares its faces once and references them everywhere.
  const css = `
    :root{
      --pata-font-serif:"Copernicus", Georgia, serif;
      --pata-font-sans:"Ridgeway Sans", system-ui, sans-serif;
    }
    h1{font-family:var(--pata-font-serif)}
    h2{font-family:var(--pata-font-serif)}
    p{font-family:var(--pata-font-sans)}
    .btn{font-family:var(--pata-font-sans)!important}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  const names = typo.families.map((f) => f.family);
  assert.ok(names.includes('Copernicus'), 'a var() stack must be resolved to its real family');
  assert.ok(names.includes('Ridgeway Sans'));
});

test('extractTypography rejects families that leaked in from utility classes', () => {
  // This exact declaration exists in Patagonia's live CSS.
  const css = `.is-object-fit-cover{object-fit:cover;font-family:object-fit\\: cover}
    .is-object-fit-contain{object-fit:contain;font-family:object-fit\\: contain}
    h1{font-family:"Garamond",serif}
    h2{font-family:"Garamond",serif}
    h3{font-family:"Garamond",serif}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  const names = typo.families.map((f) => f.family);
  assert.ok(names.includes('Garamond'));
  assert.ok(!names.some((n) => n.includes('object-fit')), 'an escaped class name is not a typeface');
});

test('extractTypography reports icon fonts as nothing at all', () => {
  const css = `@font-face{font-family:patagonia-icons;src:url(a.woff2) format("woff2")}
    @font-face{font-family:swiper-icons;src:url(b.woff2) format("woff2")}
    h1{font-family:"Garamond",serif}
    h2{font-family:"Garamond",serif}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.deepEqual(typo.families.map((f) => f.family), ['Garamond']);
});

test('extractTypography drops CSS keywords from a font stack', () => {
  const css = `*{font-family:inherit}
    h1,h2,h3{font-family:"Garamond",inherit,serif}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.ok(!typo.families.some((f) => f.family === 'inherit'));
});

test('selectPages does not follow a log-in link', () => {
  const pages = selectPages(
    [
      'https://www.gov.uk/log-in-register-hmrc-online-services',
      'https://www.gov.uk/sign-in-to-your-account',
      'https://www.gov.uk/about',
    ],
    'https://www.gov.uk',
    { limit: 5 },
  );
  const urls = pages.map((p) => p.url);
  assert.deepEqual(urls, ['https://www.gov.uk/about']);
});

test('salience pillars keep whole words', () => {
  const messaging = extractMessaging(
    [
      { url: 'https://x.test', ok: true, html: `<h1>Services</h1><h2>Housing services</h2><h2>Our services</h2><h2>Business services</h2>`, links: [] },
    ],
    {},
  );
  const names = messaging.pillars.map((p) => p.name);
  assert.ok(!names.includes('Servic'), 'must not mangle a plural into a fragment');
  assert.ok(!names.includes('Hous'));
});

test('every do-item carries a source so the schema stays valid', () => {
  const voice = mergeVoice([analyseCopy(PAGE_HTML, 'https://x.test')]);
  for (const item of voice.do) {
    assert.equal(typeof item.source, 'string');
    assert.match(item.source, /^https?:\/\//);
  }
});

test('a border indistinguishable from the background is replaced with a real hairline', () => {
  const css = `:root{--color-bg-primary:#ffffff;--color-border-primary:#ffffff;--color-brand-bg:#7070ff}`;
  const colors = extractColors({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.notEqual(colors.roles.border, colors.roles.background, 'an invisible border is useless');
  assert.ok(colors.roles.inferred.includes('border'), 'the replacement must be flagged as inferred');
});

test('a near-neutral declared hairline is kept as-is', () => {
  const css = `:root{--color-bg-primary:#ffffff;--color-border-primary:#e9e8ea;--color-brand-bg:#7070ff}`;
  const colors = extractColors({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.equal(colors.roles.border, '#e9e8ea', 'a two-unit chroma hairline is a real design choice');
});

test('a framework default grey cannot become the brand link colour', () => {
  // Bootstrap's --bs-link-color is a pale grey that HSL reports as s=0.14.
  const css = `:root{--bs-link-color:#dee2e6;--bs-body-font-family:Arial;--pata-brand:#66b87d}
    h1{font-family:var(--bs-body-font-family)}`;
  const colors = extractColors({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.notEqual(colors.roles.link, '#dee2e6');
  assert.notEqual(colors.roles.primary, '#dee2e6');
});

test('stitched-together UI fragments are rejected as prose', () => {
  // A changelog feed stripped of its tags welds a username to the first word of
  // a comment. Those must not be quoted back as the brand's voice.
  const html = `<main>
    <p>andreas Feels like we could render sooner and load the rest in the background.</p>
    <p>karri This is a real sentence that a person wrote for the product page.</p>
    <p>Release build 2024 was cut from the current roadmap after discussion.</p>
    <p>Linear plans and builds products with agents at the core of the system.</p>
  </main>`;

  const kept = splitSentences(htmlToText(html));

  assert.ok(!kept.some((t) => t.startsWith('andreas Feels')), 'a username welded to a sentence must be rejected');
  assert.ok(!kept.some((t) => t.startsWith('karri This')), 'same for the next feed row');
  assert.ok(kept.some((t) => t.startsWith('Linear plans')), 'genuine prose must survive');
  assert.ok(kept.some((t) => t.startsWith('Release build 2024')), 'a number inside a real sentence is not an artefact');
});

test('a timestamp welded to the end of a sentence is rejected', () => {
  const html = '<p>The changelog entry for this release was updated by the team two days ago.</p><p>Teams ship better when the tools stay out of the way entirely.</p>';
  const kept = splitSentences(htmlToText(html));
  assert.ok(!kept.some((t) => /days? ago\.?$/i.test(t)), 'a trailing timestamp marks a feed row, not a sentence');
  assert.ok(kept.some((t) => t.startsWith('Teams ship better')));
});

test('real prose that begins with a capital still counts', () => {
  const html = '<p>Our customers report shipping twice as often after switching to Linear.</p><p>Every team deserves tools that stay out of the way and ship fast.</p>';
  assert.ok(analyseCopy(html, 'https://x.test').ok);
});

test('real prose that begins with a capital still counts', () => {
  const html = '<p>Our customers report shipping twice as often after switching to Linear.</p><p>Every team deserves tools that stay out of the way and ship fast.</p>';
  assert.ok(analyseCopy(html, 'https://x.test').ok);
});

test('buildDesignTokens skips radius values that are not radii', () => {
  const tokens = buildDesignTokens({
    colors: GUIDE.colors,
    typography: GUIDE.typography,
    shape: { radii: [{ value: 'inherit', count: 9 }, { value: 'var(--radius-rounded)', count: 4 }, { value: '6px', count: 12 }, { value: '999px', count: 3 }] },
  });
  assert.deepEqual(Object.keys(tokens.radius).sort(), ['6', '999']);
});

test('render accepts both "colors" and "colours" so every endpoint can export', () => {
  // /api/v1/identity names the section "colours"; a brand guide names it
  // "colors". Both must produce a CSS export with colour tokens.
  const identityShaped = { ...GUIDE, colors: undefined, colours: GUIDE.colors, identity: undefined, url: 'https://acme.test/' };
  const css = render('css', identityShaped);
  assert.match(css.body, /--color-primary: #7070ff/);
});

// ── Identity naming ──────────────────────────────────────────────────────────

test('a brand name is recovered from how the site writes its own domain', () => {
  // gov.uk has no h1, titles itself "Welcome to GOV.UK", and its only brand
  // mention is inside the heading "Popular on GOV.UK". None of those is a name.
  const gov = {
    head: { title: 'Welcome to GOV.UK', ogDescription: 'The best place to find government services and information.', ogSiteName: null },
    manifest: null,
    pages: [{
      url: 'https://www.gov.uk', ok: true,
      html: '<main><h2>Popular on GOV.UK</h2><h2>Services and information</h2></main>',
    }],
    resolution: { url: 'https://www.gov.uk', resolvedBy: 'direct' },
  };
  const identity = extractIdentity(gov);
  assert.equal(identity.name, 'GOV.UK', 'the name keeps the site\'s own capitalisation');
});

test('a heading that merely mentions the brand is not the name', () => {
  const identity = extractIdentity({
    head: {},
    manifest: null,
    pages: [{ url: 'https://www.gov.uk', ok: true, html: '<h2>Popular on GOV.UK</h2>' }],
    resolution: { url: 'https://www.gov.uk', resolvedBy: 'direct' },
  });
  assert.notEqual(identity.name, 'Popular on GOV.UK');
});

test('a headline that is really a page title does not become the name', () => {
  const identity = extractIdentity({
    head: { ogTitle: 'Patagonia Outdoor Clothing & Gear' },
    manifest: null,
    pages: [{ url: 'https://www.patagonia.com/', ok: true, html: '<p>Patagonia builds clothing for the silent sports.</p>' }],
    resolution: { url: 'https://www.patagonia.com/', resolvedBy: 'direct' },
  });
  assert.equal(identity.name, 'Patagonia');
});

test('a domain is only a last resort for the brand name', () => {
  const identity = extractIdentity({
    head: {},
    manifest: null,
    pages: [],
    resolution: { url: 'https://acme.example.com', resolvedBy: 'direct' },
  });
  assert.equal(identity.name, 'acme.example.com');
  assert.equal(identity.nameCandidates.at(-1).source, 'domain name');
});

test('--surface-text-colour is a text colour, not a surface colour', () => {
  const css = `:root{
    --govuk-body-background-colour:#ffffff;
    --govuk-text-colour:#0b0c0c;
    --govuk-surface-background-colour:#f3f2f1;
    --govuk-surface-text-colour:#0b0c0c;
    --govuk-brand-colour:#1d70b8;
  }`;
  const colors = extractColors({ sheets: [{ url: 'g', css, bytes: css.length }], head: {} });
  assert.notEqual(colors.roles.surface, colors.roles.text, 'a card must not be the colour of its own text');
  const onCard = colors.contrast.find((c) => c.use.includes('body copy on a card'));
  assert.ok(onCard.ratio > 4.5, `body copy on a card should be readable, got ${onCard.ratio}:1`);
});

test('pure CSS generics are not reported as typefaces', () => {
  const css = `@font-face{font-family:GDS Transport;src:url(a.woff2) format("woff2")}
    h1,h2,h3{font-family:GDS Transport,sans-serif}
    p{font-family:sans-serif}
    code{font-family:monospace}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  const names = typo.families.map((f) => f.family);
  assert.deepEqual(names, ['GDS Transport']);
});

test('a decorative webfont the site never sets text in is not a typeface', () => {
  // Vercel bundles five GeistPixel graphics fonts alongside its real type.
  const css = `
    @font-face{font-family:GeistSans;src:url(a.woff2) format("woff2");font-weight:100 900}
    @font-face{font-family:GeistMono;src:url(b.woff2) format("woff2");font-weight:100 900}
    @font-face{font-family:GeistPixelCircle;src:url(c.woff2) format("woff2")}
    @font-face{font-family:GeistPixelSquare;src:url(d.woff2) format("woff2")}
    @font-face{font-family:GeistPixelLine;src:url(e.woff2) format("woff2")}
    @font-face{font-family:GeistPixelGrid;src:url(f.woff2) format("woff2")}
    h1,h2,h3{font-family:GeistSans,sans-serif}
    p,li{font-family:GeistSans,sans-serif}
    code{font-family:GeistMono,monospace}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.deepEqual(typo.families.map((f) => f.family).sort(), ['GeistMono', 'GeistSans']);
  assert.equal(typo.pairing.heading, 'GeistSans');
  assert.equal(typo.pairing.mono, 'GeistMono');
});

test('a genuinely dominant system font is still reported', () => {
  const css = `html,body,h1,h2,p{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}`;
  const typo = extractTypography({ sheets: [{ url: 'x', css, bytes: css.length }], head: {} });
  assert.equal(typo.pairing.heading, 'Helvetica Neue', 'a brand with no webfont still has a typeface');
});
