/**
 * Unit tests: colour maths, CSS reading, input classification, and the
 * JSON Schema validator. No network required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseColor, toHex, rgbToHsl, hslToRgb, contrastRatio, wcagGrade,
  deltaE2000, deltaE2000Lab, rgbToLab, mix, describeColour, relativeLuminance,
} from '../src/lib/colour.js';

import {
  stripComments, parseCustomProperties, resolveCustomProperty, parseFontFaces,
  splitFontStack, findColourOccurrences, parseTypeSizes,
} from '../src/lib/css.js';

import { classifyInput, normaliseUrl, rootHost, sameSite, InputError } from '../src/resolve/input.js';
import { prioritiseStylesheets } from '../src/crawl/css.js';
import { selectPages } from '../src/crawl/pages.js';
import { parseHead, decodeEntities } from '../src/crawl/head.js';
import { validate, BRAND_GUIDE_SCHEMA } from '../src/schema.js';

// ── Colour parsing ──────────────────────────────────────────────────────────

test('parseColor handles every common CSS notation', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#7070ff'), { r: 112, g: 112, b: 255, a: 1 });
  assert.deepEqual(parseColor('#7070ff80').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1,2,3,0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
});

test('parseColor rejects nonsense without throwing', () => {
  for (const bad of ['', 'notacolour', '#12', '#12345', 'rgb(', 'javascript:alert(1)', null, 42]) {
    assert.equal(parseColor(bad), null, `expected null for ${bad}`);
  }
});

test('toHex pads and clamps', () => {
  assert.equal(toHex({ r: 0, g: 8, b: 255 }), '#0008ff');
  assert.equal(toHex({ r: -20, g: 300, b: 12.6 }), '#00ff0d');
});

// ── HSL round trip ──────────────────────────────────────────────────────────

test('rgbToHsl and hslToRgb round trip', () => {
  const samples = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 128, b: 128 },
    { r: 112, g: 112, b: 255 },
    { r: 18, g: 18, b: 18 },
    { r: 240, g: 180, b: 90 },
  ];
  for (const rgb of samples) {
    const hsl = rgbToHsl(rgb);
    const back = hslToRgb(hsl.h, hsl.s, hsl.l);
    for (const channel of ['r', 'g', 'b']) {
      assert.ok(Math.abs(back[channel] - rgb[channel]) <= 1, `${channel} drifted for ${toHex(rgb)}`);
    }
  }
});

test('greys have zero saturation and no hue', () => {
  const hsl = rgbToHsl({ r: 128, g: 128, b: 128 });
  assert.equal(hsl.s, 0);
  assert.equal(hsl.l, 128 / 255);
});

// ── WCAG ────────────────────────────────────────────────────────────────────

test('contrast ratio matches the WCAG reference values', () => {
  // Reference values from the WCAG 2.1 specification.
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.equal(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1);
  assert.ok(Math.abs(contrastRatio({ r: 0x28, g: 0x2a, b: 0x30 }, { r: 255, g: 255, b: 255 }) - 14.34) < 0.05);
});

test('relativeLuminance is 0 for black and 1 for white', () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test('wcagGrade thresholds', () => {
  assert.equal(wcagGrade(21).label, 'AAA');
  assert.equal(wcagGrade(7).label, 'AAA');
  assert.equal(wcagGrade(4.5).label, 'AA');
  assert.equal(wcagGrade(3.5).label, 'AA Large');
  assert.equal(wcagGrade(1.2).label, 'Fail');
});

// ── CIEDE2000 ───────────────────────────────────────────────────────────────

test('deltaE2000 is zero for identical colours', () => {
  assert.equal(deltaE2000({ r: 112, g: 112, b: 255 }, { r: 112, g: 112, b: 255 }), 0);
});

test('deltaE2000 separates perceptually different colours', () => {
  const same = deltaE2000({ r: 112, g: 112, b: 255 }, { r: 113, g: 112, b: 255 });
  const similar = deltaE2000({ r: 112, g: 112, b: 255 }, { r: 96, g: 96, b: 255 });
  const different = deltaE2000({ r: 112, g: 112, b: 255 }, { r: 34, g: 197, b: 94 });
  const white = deltaE2000({ r: 112, g: 112, b: 255 }, { r: 255, g: 255, b: 255 });

  assert.ok(same < 1, 'near-identical should be under 1');
  assert.ok(similar < 12, 'a related purple should be under 12');
  assert.ok(different > 40, 'purple vs green should be well over 40');
  assert.ok(white > 40, 'purple vs white should be well over 40');
});

test('deltaE2000 matches the full Sharma et al. reference set', () => {
  // The published CIEDE2000 test set is expressed in CIE Lab, so this drives the
  // Lab entry point directly. All 34 pairs are checked because a naive
  // implementation matches the easy ones and fails the hue-rotation, the
  // blue-region discontinuity, and the near-zero-chroma cases.
  const pairs = [
    { a: [50.0000, 2.6772, -79.7751], b: [50.0000, 0.0000, -82.7485], expected: 2.0425 },
    { a: [50.0000, 3.1571, -77.2803], b: [50.0000, 0.0000, -82.7485], expected: 2.8615 },
    { a: [50.0000, 2.8361, -74.0200], b: [50.0000, 0.0000, -82.7485], expected: 3.4412 },
    { a: [50.0000, -1.3802, -84.2814], b: [50.0000, 0.0000, -82.7485], expected: 1.0000 },
    { a: [50.0000, -1.1848, -84.8006], b: [50.0000, 0.0000, -82.7485], expected: 1.0000 },
    { a: [50.0000, -0.9009, -85.5211], b: [50.0000, 0.0000, -82.7485], expected: 1.0000 },
    { a: [50.0000, 0.0000, 0.0000], b: [50.0000, -1.0000, 2.0000], expected: 2.3669 },
    { a: [50.0000, -1.0000, 2.0000], b: [50.0000, 0.0000, 0.0000], expected: 2.3669 },
    { a: [50.0000, 2.4900, -0.0010], b: [50.0000, -2.4900, 0.0009], expected: 7.1792 },
    { a: [50.0000, 2.4900, -0.0010], b: [50.0000, -2.4900, 0.0010], expected: 7.1792 },
    { a: [50.0000, 2.4900, -0.0010], b: [50.0000, -2.4900, 0.0011], expected: 7.2195 },
    { a: [50.0000, 2.4900, -0.0010], b: [50.0000, -2.4900, 0.0012], expected: 7.2195 },
    { a: [50.0000, -0.0010, 2.4900], b: [50.0000, 0.0009, -2.4900], expected: 4.8045 },
    { a: [50.0000, -0.0010, 2.4900], b: [50.0000, 0.0010, -2.4900], expected: 4.8045 },
    { a: [50.0000, -0.0010, 2.4900], b: [50.0000, 0.0011, -2.4900], expected: 4.7461 },
    { a: [50.0000, 2.5000, 0.0000], b: [50.0000, 0.0000, -2.5000], expected: 4.3065 },
    { a: [50.0000, 2.5000, 0.0000], b: [73.0000, 25.0000, -18.0000], expected: 27.1492 },
    { a: [50.0000, 2.5000, 0.0000], b: [61.0000, -5.0000, 29.0000], expected: 22.8977 },
    { a: [50.0000, 2.5000, 0.0000], b: [56.0000, -27.0000, -3.0000], expected: 31.9030 },
    { a: [50.0000, 2.5000, 0.0000], b: [58.0000, 24.0000, 15.0000], expected: 19.4535 },
    { a: [50.0000, 2.5000, 0.0000], b: [50.0000, 3.1736, 0.5854], expected: 1.0000 },
    { a: [50.0000, 2.5000, 0.0000], b: [50.0000, 3.2972, 0.0000], expected: 1.0000 },
    { a: [50.0000, 2.5000, 0.0000], b: [50.0000, 1.8634, 0.5757], expected: 1.0000 },
    { a: [50.0000, 2.5000, 0.0000], b: [50.0000, 3.2592, 0.3350], expected: 1.0000 },
    { a: [60.2574, -34.0099, 36.2677], b: [60.4626, -34.1751, 39.4387], expected: 1.2644 },
    { a: [63.0109, -31.0961, -5.8663], b: [62.8187, -29.7946, -4.0864], expected: 1.2630 },
    { a: [61.2901, 3.7196, -5.3901], b: [61.4292, 2.2480, -4.9620], expected: 1.8731 },
    { a: [35.0831, -44.1164, 3.7933], b: [35.0232, -40.0716, 1.5901], expected: 1.8645 },
    { a: [22.7233, 20.0904, -46.6940], b: [23.0331, 14.9730, -42.5619], expected: 2.0373 },
    { a: [36.4612, 47.8580, 18.3852], b: [36.2715, 50.5065, 21.2231], expected: 1.4146 },
    { a: [90.8027, -2.0831, 1.4410], b: [91.1528, -1.6435, 0.0447], expected: 1.4441 },
    { a: [90.9257, -0.5406, -0.9208], b: [88.6381, -0.8985, -0.7239], expected: 1.5381 },
    { a: [6.7747, -0.2908, -2.4247], b: [5.8714, -0.0985, -2.2286], expected: 0.6377 },
    { a: [2.0776, 0.0795, -1.1350], b: [0.9033, -0.0636, -0.5514], expected: 0.9082 },
  ];

  for (const [index, { a, b, expected }] of pairs.entries()) {
    const actual = deltaE2000Lab(a, b);
    assert.ok(
      Math.abs(actual - expected) < 0.0002,
      `pair ${index + 1}: expected ${expected}, got ${actual}`,
    );
  }
});

test('mix interpolates between two colours', () => {
  assert.equal(toHex(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)), '#808080');
  assert.equal(toHex(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0)), '#000000');
  assert.equal(toHex(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 1)), '#ffffff');
});

test('describeColour reports every notation', () => {
  const described = describeColour({ r: 112, g: 112, b: 255 });
  assert.equal(described.hex, '#7070ff');
  assert.match(described.rgb, /^rgb\(112, 112, 255\)$/);
  assert.match(described.hsl, /^hsl\(\d+, \d+%, \d+%\)$/);
});

// ── CSS reading ─────────────────────────────────────────────────────────────

test('stripComments removes comments but not url() data', () => {
  assert.equal(stripComments('a{color:red}/*x*/b{}').includes('/*'), false);
  const withUrl = 'a{background:url("http://x/y.png")/*c*/}';
  assert.ok(stripComments(withUrl).includes('http://x/y.png'));
});

test('parseCustomProperties reads minified custom properties', () => {
  const props = parseCustomProperties('.a{--color-bg-primary:#fff;--x:2px}')
    || parseCustomProperties('.a{--color-bg-primary:#fff;--x:2px}');
  assert.equal(props.get('--color-bg-primary').value, '#fff');
  assert.equal(props.get('--x').value, '2px');
});

test('parseCustomProperties reads a real Tailwind v4 @theme block', () => {
  const css = '@theme{--color-text-primary:#282a30;--color-bg-primary:#fff;--spacing-4:1rem}';
  const props = parseCustomProperties(css);
  assert.equal(props.get('--color-text-primary').value, '#282a30');
  assert.equal(props.get('--spacing-4').value, '1rem');
});

test('resolveCustomProperty follows var() alias chains', () => {
  const props = parseCustomProperties(':root{--a:#fff;--b:var(--a);--c:var(--b);--missing:var(--nope,#123456)}');
  assert.equal(resolveCustomProperty(props, '--a'), '#fff');
  assert.equal(resolveCustomProperty(props, '--b'), '#fff');
  assert.equal(resolveCustomProperty(props, '--c'), '#fff');
  assert.equal(resolveCustomProperty(props, '--missing'), '#123456');
  assert.equal(resolveCustomProperty(props, '--absent'), null);
});

test('resolveCustomProperty survives a circular reference', () => {
  const props = parseCustomProperties(':root{--a:var(--b);--b:var(--a)}');
  assert.doesNotThrow(() => resolveCustomProperty(props, '--a'));
});

test('parseFontFaces extracts family, weights and formats', () => {
  const css = `@font-face{font-family:"Inter Variable";src:url(a.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:'Berkeley Mono';src:url(b.woff2) format("woff2");font-style:normal}`;
  const faces = parseFontFaces(css);
  assert.equal(faces.length, 2);
  assert.equal(faces[0].family, 'Inter Variable');
  assert.equal(faces[0].weight, '100 900');
  assert.ok(faces[0].isVariable);
  assert.ok(faces[0].formats.includes('woff2'));
  assert.equal(faces[1].family, 'Berkeley Mono');
});

test('splitFontStack separates families and drops var() references', () => {
  assert.deepEqual(
    splitFontStack(`"Inter Variable", -apple-system, BlinkMacSystemFont, sans-serif`),
    ['Inter Variable', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
  );
  assert.deepEqual(splitFontStack('var(--font-body)'), []);
});

test('findColourOccurrences counts hex, rgb and hsl literals', () => {
  const counts = findColourOccurrences('.a{color:#fff}.b{color:#fff}.c{color:#7070ff}.d{color:rgb(1,2,3)}.e{color:hsl(0,0%,0%)}');
  assert.equal(counts.get('#fff'), 2);
  assert.equal(counts.get('#7070ff'), 1);
  assert.ok(counts.has('rgb(1,2,3)'), 'rgb literal must be counted');
  assert.ok(counts.has('hsl(0,0%,0%)'));
});

test('parseTypeSizes handles minified CSS', () => {
  assert.deepEqual(parseTypeSizes('.a{font-size:clamp(1rem,2vw,2rem)}.b{font-size:14px}').map((s) => s.clamp), [true, false]);
});

// ── Input classification ────────────────────────────────────────────────────

test('classifyInput tells a URL from a company name', () => {
  assert.equal(classifyInput('linear.app').kind, 'url');
  assert.equal(classifyInput('https://linear.app').kind, 'url');
  assert.equal(classifyInput('www.gov.uk').kind, 'url');
  assert.equal(classifyInput('GOV.UK').kind, 'name');
  assert.equal(classifyInput('@vercel').kind, 'name');
  assert.equal(classifyInput('vercel').name, 'vercel');
});

test('classifyInput strips conversational filler', () => {
  assert.equal(classifyInput('the website for linear').name, 'linear');
  assert.equal(classifyInput('linear official site').name, 'linear');
});

test('normaliseUrl adds a scheme and strips tracking parameters', () => {
  assert.equal(normaliseUrl('linear.app'), 'https://linear.app/');
  assert.equal(normaliseUrl('linear.app?utm_source=x&ref=y'), 'https://linear.app/');
  assert.equal(normaliseUrl('https://linear.app/index.html#top'), 'https://linear.app/');
});

test('normaliseUrl refuses unsafe targets', () => {
  assert.throws(() => normaliseUrl('http://localhost:3000'), InputError);
  assert.throws(() => normaliseUrl('http://127.0.0.1'), InputError);
  assert.throws(() => normaliseUrl('http://192.168.1.1'), InputError);
  assert.throws(() => normaliseUrl('http://169.254.169.254'), InputError);
  assert.throws(() => normaliseUrl('ftp://example.com'), InputError);
  assert.throws(() => normaliseUrl('javascript:alert(1)'), InputError);
});

test('rootHost and sameSite group subdomains', () => {
  assert.equal(rootHost('https://app.linear.app/x'), 'linear.app');
  assert.equal(rootHost('https://www.gov.uk'), 'gov.uk');
  assert.equal(sameSite('https://docs.linear.app', 'https://linear.app'), true);
  assert.equal(sameSite('https://notion.so', 'https://linear.app'), false);
});

test('classifyInput rejects empty and oversized input', () => {
  assert.throws(() => classifyInput(''), InputError);
  assert.throws(() => classifyInput('   '), InputError);
  assert.throws(() => classifyInput('x'.repeat(400)), InputError);
  assert.throws(() => classifyInput(null), InputError);
});

// ── Crawl planning ──────────────────────────────────────────────────────────

test('prioritiseStylesheets puts global token files first', () => {
  const ranked = prioritiseStylesheets([
    'https://cdn.x.com/vendor/bootstrap.min.css',
    'https://cdn.x.com/_next/static/css/a1b2c3d4.css',
    'https://cdn.x.com/assets/globals.css',
  ]);
  assert.match(ranked[0].url, /globals/);
  assert.match(ranked[ranked.length - 1].url, /bootstrap/);
});

test('selectPages prefers company pages and stays on domain', () => {
  const pages = selectPages(
    [
      'https://linear.app/about',
      'https://linear.app/careers/',
      'https://linear.app/pricing',
      'https://linear.app/blog/some-post',
      'https://linear.app/legal/privacy',
      'https://linear.app/login',
      'https://evil.example/about',
      'https://linear.app/about#team',
    ],
    'https://linear.app',
    { limit: 6 },
  );

  const urls = pages.map((p) => p.url);
  assert.ok(urls.includes('https://linear.app/about'));
  assert.ok(urls.includes('https://linear.app/careers/'));
  assert.ok(!urls.some((u) => u.includes('evil.example')));
  assert.ok(!urls.some((u) => u.includes('/login')), 'auth pages must be skipped');
  assert.ok(!urls.some((u) => u.includes('privacy')), 'legal pages must be skipped');
  assert.ok(pages.find((p) => p.url.includes('careers')).score >= pages.find((p) => p.url.includes('pricing')).score);
});

test('selectPages caps how many pages share one intent', () => {
  const links = ['a', 'b', 'c', 'd'].map((n) => `https://x.com/blog/${n}`);
  const pages = selectPages(links, 'https://x.com', { limit: 10 });
  assert.ok(pages.filter((p) => p.intent === 'blog').length <= 2);
});

// ── Head parsing ────────────────────────────────────────────────────────────

test('parseHead pulls the metadata the pipeline depends on', () => {
  const head = `<head>
    <title>Fallback title</title>
    <meta property="og:title" content="Linear – product development"/>
    <meta name="description" content="Purpose-built."/>
    <meta property="og:image" content="https://cdn.x.com/og.png"/>
    <meta name="theme-color" content="#08090a"/>
    <link rel="stylesheet" href="https://cdn.x.com/a.css"/>
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg"/>
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
    <link rel="manifest" href="/pwa.webmanifest">
  </head>`;

  const parsed = parseHead(head, 'https://linear.app/');

  assert.equal(parsed.ogTitle, 'Linear – product development');
  assert.equal(parsed.themeColor, '#08090a');
  assert.equal(parsed.ogImage, 'https://cdn.x.com/og.png');
  assert.deepEqual(parsed.stylesheets, ['https://cdn.x.com/a.css']);
  assert.equal(parsed.manifestUrl, 'https://linear.app/pwa.webmanifest');
  assert.equal(parsed.icons.length, 2);
  assert.ok(parsed.icons.some((i) => i.url.endsWith('/static/favicon.svg')));
});

test('parseHead resolves relative hrefs against the final URL', () => {
  const parsed = parseHead('<head><link rel="icon" href="/f.ico"></head>', 'https://x.com/deep/page/');
  assert.equal(parsed.icons[0].url, 'https://x.com/f.ico');
});

test('parseHead tolerates a missing or malformed head', () => {
  assert.doesNotThrow(() => parseHead('', 'https://x.com/'));
  assert.doesNotThrow(() => parseHead('<head><meta name=', 'https://x.com/'));
  assert.equal(parseHead('', 'https://x.com/').title, null);
});

test('decodeEntities handles the numeric and named forms in og tags', () => {
  assert.equal(decodeEntities('A &amp; B'), 'A & B');
  assert.equal(decodeEntities('it&#8217;s'), 'it\u2019s', 'a typographic apostrophe is preserved');
  assert.equal(decodeEntities('&#x2014;'), '—');
  assert.equal(decodeEntities('&quot;q&quot;'), '"q"');
});

// ── Schema validator ────────────────────────────────────────────────────────

test('validate catches the things a bad guide would do', () => {
  assert.ok(validate({}, BRAND_GUIDE_SCHEMA).length > 0, 'empty object must fail');

  const bad = { schemaVersion: 'one', generatedAt: 'x', input: {}, identity: {}, logos: {}, colors: {}, typography: {}, voice: {}, messaging: {}, confidence: {}, provenance: {} };
  const errors = validate(bad, BRAND_GUIDE_SCHEMA);
  assert.ok(errors.some((e) => e.includes('schemaVersion') && e.includes('does not match')), 'the version pattern must be enforced');
  assert.ok(errors.some((e) => e.includes('input.given')), 'missing required properties are reported');
  assert.ok(errors.some((e) => e.includes('input.kind')), 'enum violations are reported');
  assert.ok(validate('not an object', BRAND_GUIDE_SCHEMA).length > 0, 'a non-object must fail');
  assert.ok(validate([], BRAND_GUIDE_SCHEMA).length > 0, 'an array must fail an object schema');
});

test('validate accepts a well-formed minimal guide', () => {
  const guide = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    input: { given: 'linear', kind: 'url', resolvedUrl: 'https://linear.app/', resolvedBy: 'direct' },
    identity: { name: 'Linear', url: 'https://linear.app/' },
    logos: { primary: null, source: { method: 'x' } },
    colors: {
      tokens: [{ hex: '#7070ff', rgb: 'rgb(112, 112, 255)', hsl: 'hsl(240, 100%, 72%)', name: 'royalblue' }],
      roles: { primary: '#7070ff', background: '#ffffff', text: '#282a30' },
      contrast: [{ foreground: '#282a30', background: '#ffffff', ratio: 14.34 }],
    },
    typography: { families: [], pairing: {} },
    voice: { ok: false },
    messaging: { pillars: [] },
    confidence: { overall: 0.7, bySection: {}, basis: 'x' },
    provenance: { tinyfish: { calls: [], totalCalls: 0 }, pagesRead: [], methods: ['x'] },
  };
  assert.deepEqual(validate(guide, BRAND_GUIDE_SCHEMA), []);
});

test('validate enforces the verifiedBy contract on logos', () => {
  const guide = {
    schemaVersion: '1.0.0', generatedAt: new Date().toISOString(),
    input: { given: 'x', kind: 'url', resolvedUrl: 'https://x.com/', resolvedBy: 'direct' },
    identity: { name: 'X', url: 'https://x.com/' },
    logos: { primary: { url: 'https://x.com/l.png', format: 'png', verifiedBy: 'guesswork' }, source: {} },
    colors: { tokens: [], roles: { primary: '#fff', background: '#fff', text: '#000' }, contrast: [] },
    typography: { families: [], pairing: {} },
    voice: { ok: false }, messaging: { pillars: [] },
    confidence: { overall: 0, bySection: {}, basis: '' },
    provenance: { tinyfish: { calls: [], totalCalls: 0 }, pagesRead: [], methods: [] },
  };
  const errors = validate(guide, BRAND_GUIDE_SCHEMA);
  assert.ok(errors.some((e) => e.includes('verifiedBy')), 'an unverified logo must be rejected by the schema');
});
// ── Domain resolution ranking ────────────────────────────────────────────────

/**
 * Exercise the ranker directly with the candidate shapes real search returns.
 * @param {Array<object>} results
 * @param {string} name
 */
async function rankFor(results, name) {
  const { rankCandidatesForTest } = await import('../src/resolve/domain.js');
  return rankCandidatesForTest(results, name);
}

test('a tracking parameter in the URL does not change the ranking', async () => {
  const messy = [
    { url: 'https://www.linear.eu/en/home/?srsltid=AU7gw4XaIlVHyS9Le9eyN6IiApMVOLKEKK6bky', position: 5, title: 'LINEAR - The BIM Engineering Software', site_name: 'www.linear.eu' },
    { url: 'https://linear.app/', position: 1, title: 'Linear - The system for product development', site_name: 'linear.app' },
  ];
  const ranked = await rankFor(messy, 'linear');
  assert.equal(ranked[0].url, 'https://linear.app/', 'the homepage must win regardless of query junk');
  assert.ok(!ranked[0].url.includes('?'), 'the query string is stripped before crawling');
});

test('hosted profile pages are rejected outright', async () => {
  const results = [
    { url: 'https://www.linkedin.com/company/linearapp', position: 4, title: 'Linear - LinkedIn' },
    { url: 'https://x.com/linear/all', position: 7, title: 'Linear - X' },
    { url: 'https://www.crunchbase.com/organization/linear', position: 3, title: 'Linear' },
  ];
  assert.deepEqual(await rankFor(results, 'linear'), []);
});

test('a bare homepage outranks a deep page on the same brand', async () => {
  const results = [
    { url: 'https://acme.com/en/pricing/v2/enterprise', position: 1, title: 'Pricing' },
    { url: 'https://acme.com/', position: 4, title: 'Acme', site_name: 'acme.com' },
  ];
  const ranked = await rankFor(results, 'acme');
  assert.equal(ranked[0].url, 'https://acme.com/');
});

test('a local subdomain is demoted', async () => {
  const results = [
    { url: 'https://de.acme.com/', position: 1, title: 'Acme Deutschland' },
    { url: 'https://acme.com/', position: 2, title: 'Acme', site_name: 'acme.com' },
  ];
  const ranked = await rankFor(results, 'acme');
  assert.equal(ranked[0].url, 'https://acme.com/');
});

test('a subdomain does not outrank the brand main site', async () => {
  // Searching "patagonia" returns wornwear.patagonia.com above patagonia.com,
  // because the brand name is in its hostname. It is a resale line, not the brand.
  const results = [
    { url: 'https://wornwear.patagonia.com/', position: 2, title: 'Worn Wear' },
    { url: 'https://www.patagonia.com/', position: 1, title: 'Patagonia Outdoor Clothing & Gear' },
  ];
  const ranked = await rankFor(results, 'patagonia');
  assert.equal(ranked[0].url, 'https://www.patagonia.com/');
});
