/**
 * Guide length and the pure helpers behind the deck's two judgement calls.
 *
 * The page budget is the contract the UI offers the user: ask for a length, get
 * that many pages, or be told why you got fewer. These tests pin that down along
 * with swatch naming and variable-font weight stops, because both of those
 * quietly produce wrong-looking pages when they are wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampPages, pillarsForBudget, MIN_PAGES, MAX_PAGES, DEFAULT_PAGES,
} from '../src/lib/page-budget.js';

import { findLockup } from '../src/extract/logo.js';
import { sanitiseSvg, svgTone, colourLuminance } from '../src/extract/svg.js';

import { swatchNames, weightStops, mix, luminance, inkOn, brandName, scaleLabel, measuredDeck, plateIsLight, introductionColumns, fullDeck, plural, aimStatement }
  from '../public/deck.js';

test('a page budget falls back to the default when nothing usable arrives', () => {
  for (const input of [undefined, null, '', 'abc', NaN, {}, []]) {
    assert.equal(clampPages(input), DEFAULT_PAGES, `input ${JSON.stringify(input)}`);
  }
});

test('a page budget is clamped at both ends rather than trusted', () => {
  assert.equal(clampPages(1), MIN_PAGES);
  assert.equal(clampPages(-40), MIN_PAGES);
  assert.equal(clampPages(999), MAX_PAGES);
  assert.equal(clampPages('18'), 18, 'a query string arrives as a string');
  assert.equal(clampPages('12.7'), 12, 'a float truncates rather than rounding up');
});

test('a longer guide asks for more pillars, never longer ones', () => {
  const short = pillarsForBudget(6);
  const medium = pillarsForBudget(12);
  const long = pillarsForBudget(24);

  assert.ok(short <= medium && medium <= long, 'the count must not shrink as pages grow');
  assert.ok(long <= 5, 'the sanitiser and the deck both assume a sane ceiling');
  assert.ok(short >= 3, 'even the shortest guide is given something to work with');
});

test('a swatch is named for its role, not its nearest CSS colour', () => {
  const names = swatchNames([
    { hex: '#ffffff', name: 'white', role: 'background', roles: ['background'], tokens: ['--color-white'] },
    { hex: '#7070ff', name: 'royalblue', role: 'link', roles: ['link'], tokens: ['--color-link-primary'] },
  ]);

  // "royalblue" is a Lab-distance guess and would read as a mistake in a guide.
  assert.deepEqual(names, ['Background', 'Link']);
});

test('a role the brand has said nothing more specific about yields to the token name', () => {
  const names = swatchNames([
    // GOV.UK assigns "primary" to both its white and its blue.
    { hex: '#ffffff', name: 'white', role: 'primary', tokens: ['--govuk-body-background-colour'] },
    { hex: '#1d70b8', name: 'royalblue', role: 'primary', tokens: ['--govuk-brand-colour'] },
  ]);

  assert.deepEqual(names, ['Body Background', 'Brand Colour']);
});

test('swatch names never repeat on one spread', () => {
  const names = swatchNames([
    { hex: '#111111', name: 'black', role: 'text', tokens: [] },
    { hex: '#222222', name: 'dimgray', role: 'text', tokens: [] },
    { hex: '#333333', name: 'darkslategray', role: 'text', tokens: [] },
  ]);

  assert.equal(new Set(names).size, names.length, `repeated a name: ${names.join(', ')}`);
});

test('a variable font axis becomes printable stops, not one row labelled Thin', () => {
  const { stops, axis } = weightStops(['100 900']);
  assert.deepEqual(axis, ['100', '900']);
  // Regular through Bold, which is what the weights page documents.
  assert.deepEqual(stops, ['400', '500', '600', '700']);
});

test('a variable axis is sampled inside its own declared range', () => {
  // A family that only ships 300-600 has no Bold to show.
  assert.deepEqual(weightStops(['300 600']).stops, ['400', '500', '600']);
  assert.deepEqual(weightStops(['700']).stops, ['700']);
  assert.deepEqual(weightStops(['600 900']).stops, ['600', '700']);
});

test('discrete weights are taken as declared', () => {
  assert.deepEqual(weightStops(['400', '700']).stops, ['400', '700']);
  assert.equal(weightStops(['400', '700']).axis, null);
});

test('a weight list the extractor could not read yields nothing rather than junk', () => {
  assert.deepEqual(weightStops([]).stops, []);
  assert.deepEqual(weightStops(['thin']).stops, []);
});

test('tints mix toward whichever end keeps them apart', () => {
  assert.equal(mix('#ffffff', '#000000', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('swatch ink flips with the luminance behind it', () => {
  assert.ok(luminance('#ffffff') > luminance('#000000'));
  assert.equal(inkOn('#ffffff'), '#000000');
  assert.equal(inkOn('#101014'), '#ffffff');

  // An unreadable colour is defensive only, since the extractor only ever
  // emits validated hex. It must still return real ink rather than undefined.
  assert.ok(['#000000', '#ffffff'].includes(inkOn('not-a-colour')));
});

/* ── The deterministic deck ─────────────────────────────────────────────── */

const RICH_GUIDE = {
  identity: { name: 'Linear', domain: 'linear.app' },
  logos: {
    primary: { url: 'https://linear.app/icon.svg', format: 'svg' },
    source: { candidates: 12 },
  },
  colors: { tokens: [{ hex: '#7070ff', name: 'royalblue', role: 'link', tokens: ['--color-link-primary'] }] },
  typography: {
    pairing: { heading: 'Inter Variable' },
    families: [{ family: 'Inter Variable', kind: 'sans', weights: ['100 900'], isWebfont: true, role: 'heading' }],
    scale: [{ name: 'h1', px: 32, rem: 2, usageCount: 3 }],
  },
};

test('without a narration the deck is exactly the seven measured pages', () => {
  const pages = measuredDeck(RICH_GUIDE);

  assert.deepEqual(pages.map((p) => p.label), [
    'Cover',
    'Logomark',
    'Logotype',
    'Color Palette',
    'Typeface',
    'Weights',
    'Type Scaling',
  ]);
});

test('the measured pages carry the topic numbers of the printed deck', () => {
  const topics = measuredDeck(RICH_GUIDE).map((p) => p.topic);
  assert.deepEqual(topics, [null, '2.1', '2.2', '3.1', '4.1', '4.2', '4.3']);
});

test('the cover is unnumbered and every following page is numbered in sequence', () => {
  const pages = measuredDeck(RICH_GUIDE);
  assert.equal(pages[0].page, null, 'a front plate carries no page number');

  const numbered = pages.slice(1).map((p) => p.page);
  assert.deepEqual(numbered, [2, 3, 4, 5, 6, 7]);
});

test('a brand missing a verified logo loses the logomark page, not a hole', () => {
  const pages = measuredDeck({ ...RICH_GUIDE, logos: { primary: null, source: {} } });
  const labels = pages.map((p) => p.label);

  assert.ok(!labels.includes('Logomark'));
  assert.deepEqual(
    pages.filter((p) => p.kind !== 'cover').map((p) => p.page),
    [2, 3, 4, 5, 6],
    'page numbers must stay contiguous so the running header never lies',
  );
});

test('the cover uses the fetched brand name, never the URL it was reached at', () => {
  const cover = measuredDeck(RICH_GUIDE)[0];
  assert.equal(cover.spec().name, 'Linear');
  assert.notEqual(cover.spec().name, 'linear.app');
});

test('brandName falls back rather than printing an empty cover', () => {
  assert.equal(brandName({ name: 'GOV.UK', domain: 'gov.uk' }), 'GOV.UK');
  assert.equal(brandName({ domain: 'example.test' }), 'example.test');
  assert.equal(brandName({}), 'Unknown brand');
});

test('a type-scale token name becomes the label the template prints', () => {
  assert.equal(scaleLabel('h1'), 'Heading 1');
  assert.equal(scaleLabel('h2'), 'Heading 2');
  assert.equal(scaleLabel('display'), 'Display');
  assert.equal(scaleLabel('body'), 'Body');
  assert.equal(scaleLabel(''), 'Heading 1', 'an unnamed step still gets a label');
});

/* ── The full document: introduction, and where the wordmark lives ───────── */

/*
 * A guide carrying a narration, which is what puts the deck into its full mode.
 * Shaped like a real one: the narrative fields the sanitiser produces, and the
 * measured fields those pages are allowed to quote.
 */
const NARRATED_GUIDE = {
  ...RICH_GUIDE,
  identity: { name: 'Linear', domain: 'linear.app', description: 'Purpose-built for planning and building products with AI agents.' },
  messaging: {
    headlines: [{ text: 'The product development system for teams and agents' }],
    claims: [],
    positioning: { text: 'the product development system for teams and agents' },
    pillars: [
      { name: 'Speed', claim: 'Work moves faster.', rank: 1, prevalence: 0.8 },
      { name: 'Clarity', claim: 'The tool stays legible.', rank: 2, prevalence: 0.6 },
    ],
  },
  voice: { descriptors: [{ axis: 'Register', value: 'casual', note: 'writes the way it talks' }, { axis: 'Formality', value: 'low', note: 'contractions throughout' }], sentencesAnalysed: 60 },
  narrative: {
    toneSummary: 'Short declaratives that lead with the outcome.',
    positioning: 'a planning tool for teams that ship every day',
    pillars: [{ name: 'Speed', claim: 'Work moves faster.', evidence: 'The product development system for teams and agents' }],
    doNext: ['Lead with the result'],
    watchOuts: ['No exclamation marks'],
  },
  provenance: {
    pagesRead: ['/', '/features', '/pricing', '/docs', '/blog', '/changelog'],
    stylesheetsRead: ['/a.css', '/b.css', '/c.css'],
    tinyfish: { totalCalls: 9, totalMs: 4200 },
  },
};

test('the document opens with a written introduction, not a plate', () => {
  const pages = fullDeck(NARRATED_GUIDE);

  assert.equal(pages[0].section, 'intro');
  assert.equal(pages[0].title, 'INTRODUCTION');
  assert.equal(pages[0].opener, 'prose', 'a written opener, so it holds 1.0 instead of taking a sub-number');
  assert.equal(pages[1].spec().render, 'contents', 'the contents page follows it, as in the reference');
});

test('the introduction is two columns of real prose, never a single line', () => {
  // The bug this covers was an opening page with one line on it. A one-line
  // introduction summarises nothing, so both columns must carry several sentences
  // however little the extraction found.
  for (const guide of [NARRATED_GUIDE, { identity: { name: 'Sparse' } }, {}]) {
    const [left, right] = introductionColumns(guide);

    for (const column of [left, right]) {
      assert.ok(Array.isArray(column), 'a column is a list of sentences');
      assert.ok(column.length >= 2, `a column needs more than one sentence, got ${column.length}`);
      for (const sentence of column) {
        assert.ok(sentence.trim().endsWith('.'), `sentences are whole: ${sentence}`);
      }
    }
  }
});

test('the introduction reports what was measured and borrows no prose', () => {
  const [left, right] = introductionColumns(NARRATED_GUIDE);
  const text = [...left, ...right].join(' ');

  assert.match(text, /Linear/, 'it names the brand');
  assert.match(text, /1 colour/, 'one colour reads as "1 colour", not "1 colours"');
  assert.match(text, /1 typeface/, 'and one typeface likewise');
  assert.match(text, /6 pages/, 'counts above one are pluralised');
  assert.match(text, /3 stylesheets/);
  assert.match(text, /60 sentences/);
  assert.match(text, /TinyFish Fetch/);

  // The reference deck's own text describes its author's brand. Copying it would
  // put another company's name and another company's promises in this document.
  assert.doesNotMatch(text, /Nirakara|rushidesign|architectural|craftsmanship|heritage/i);
  assert.doesNotMatch(text, /designed by/i);
});

test('the introduction uses the narration voice only when there is one', () => {
  const withIt = introductionColumns(NARRATED_GUIDE).flat().join(' ');
  assert.match(withIt, /Short declaratives/, 'the tone summary is the narration layer’s contribution');

  const without = introductionColumns({ identity: { name: 'Quiet' } }).flat().join(' ');
  assert.doesNotMatch(without, /Short declaratives/);
  assert.ok(without.length > 120, 'and the page is still substantial without it');
});

test('plural reads as English, because a counted claim is quoted', () => {
  assert.equal(plural(1, 'colour'), '1 colour');
  assert.equal(plural(0, 'colour'), '0 colours');
  assert.equal(plural(2, 'typeface'), '2 typefaces');
  assert.equal(plural(1, 'page'), '1 page');
});

test('a positioning line is not prefixed twice or stopped twice', () => {
  // Both mistakes were in real output: "Our aim is linear is a purpose-built…",
  // and "…high-velocity teams..". The narration writes whole sentences that
  // already name the brand, so the prefix has to step aside when they do.
  assert.equal(
    aimStatement('Linear is a purpose-built product development system.', 'Linear'),
    'Linear is a purpose-built product development system.',
    'a line that already stands as a sentence about the brand is used as it is',
  );
  assert.equal(
    aimStatement('a planning tool for teams that ship daily.', 'Linear'),
    'Our aim is a planning tool for teams that ship daily.',
    'a bare noun phrase still reads correctly with the prefix',
  );
  assert.equal(aimStatement('Linear is fast.', 'Linear'), 'Linear is fast.', 'never a doubled full stop');
  assert.equal(aimStatement('Linear', 'Linear'), 'Our aim is linear.', 'a bare name still needs the prefix');
  assert.equal(aimStatement('   ', 'Linear'), null, 'nothing usable is dropped rather than padded');
  assert.equal(aimStatement(null, 'Linear'), null);
  assert.equal(aimStatement('', 'Linear'), null);
});

test('no page in the introduction draws a specimen panel', () => {
  // The positioning page used to carry a wordmark panel, which put the logotype
  // in the introduction and left the logo section without one. A wordmark belongs
  // to the logotype page and nowhere else.
  const intro = fullDeck(NARRATED_GUIDE).filter((e) => e.section === 'intro');

  assert.ok(intro.length >= 4, 'there is an introduction to check');
  for (const entry of intro) {
    assert.equal(entry.spec().panel, undefined, `${entry.label} must not carry a panel`);
  }
});

test('the logotype sits in the logo section, directly after the logomark', () => {
  const logo = fullDeck(NARRATED_GUIDE).filter((e) => e.section === 'logo');

  assert.deepEqual(
    logo.map((e) => e.label),
    ['Logomark', 'Logotype', 'Asset register'].filter((l) => logo.some((e) => e.label === l)),
    'the wordmark follows the mark it belongs with, as the reference orders them',
  );
  assert.equal(logo[1].label, 'Logotype');
  assert.equal(logo[1].section, 'logo');
});

test('a brand with no verifiable logo still gets its logotype page', () => {
  // The wordmark is typeset, not fetched, so it does not depend on an asset
  // having been verified — the reference logotype page is set type too.
  const logo = fullDeck({ ...NARRATED_GUIDE, logos: { primary: null } }).filter((e) => e.section === 'logo');
  assert.deepEqual(logo.map((e) => e.label), ['Logotype']);
});

/* ── Choosing the asset a cover should show ─────────────────────────────── */

/*
 * Tailwind's case, reproduced: the head SVG icon is the app icon, a dark
 * rounded square, and it outscores everything on score because `primary` is
 * SVG-first. Put that same dark square on a dark cover and the logo disappears.
 * The real logo is the wide asset in the page body.
 */
const TAILWIND_LIKE = [
  { url: 'https://tailwindcss.com/favicon.svg', format: 'svg', kind: 'icon', score: 88, declaredSize: 'any' },
  { url: 'https://tailwindcss.com/img/tailwind-logo.svg', format: 'svg', kind: 'logo', score: 60, declaredSize: '240x64' },
];

test('a declared wide aspect ratio wins over a higher-scoring square icon', () => {
  const lockup = findLockup(TAILWIND_LIKE);
  assert.equal(lockup.url, 'https://tailwindcss.com/img/tailwind-logo.svg');
  assert.ok(
    lockup.score < TAILWIND_LIKE[0].score,
    'the lockup can score lower and still be the right asset for a cover',
  );
});

test('a filename that says logo is treated as a lockup when no size is declared', () => {
  const lockup = findLockup([
    { url: 'https://tailwindcss.com/favicon.svg', format: 'svg', kind: 'icon', score: 88, declaredSize: 'any' },
    { url: 'https://tailwindcss.com/brand/wordmark.svg', format: 'svg', kind: 'logo', score: 40 },
  ]);
  assert.equal(lockup.url, 'https://tailwindcss.com/brand/wordmark.svg');
});

test('the social card is the lockup when nothing better was declared', () => {
  const lockup = findLockup([
    { url: 'https://tailwindcss.com/favicon.ico', format: 'ico', kind: 'icon', score: 70 },
    { url: 'https://tailwindcss.com/og.png', format: 'png', kind: 'social', score: 30 },
  ]);
  assert.equal(lockup.url, 'https://tailwindcss.com/og.png');
});

test('a square app icon is never chosen as the lockup on its own', () => {
  assert.equal(findLockup(TAILWIND_LIKE.slice(0, 1)), null);
  assert.equal(findLockup([]), null);
});

/* ── Inlining SVG so a logo keeps its colour ────────────────────────────── */

/*
 * A logo loaded through <img> cannot inherit from the page. A
 * `fill="currentColor"` logo therefore renders flat black, which is how a cyan
 * Tailwind mark arrives greyscale. Reading the source and inlining it is the
 * fix, and inlining remote markup is why the sanitiser below exists.
 */

test('a script inside a logo cannot survive sanitisation', () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<script>fetch("//evil.test")</script>'
    + '<path fill="#38bdf8" d="M0 0h10v10H0z"/></svg>';

  const clean = sanitiseSvg(dirty);
  assert.ok(!/<script/i.test(clean), 'script element stripped');
  assert.ok(!/evil\.test/.test(clean), 'script body stripped with it');
  assert.match(clean, /#38bdf8/, 'the artwork itself survives');
});

test('inline event handlers and external references are stripped', () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="steal()">'
    + '<use href="https://elsewhere.test/x.svg#y"/>'
    + '<image xlink:href="https://elsewhere.test/pixel.png"/>'
    + '<rect fill="url(https://elsewhere.test/g.svg#g)" onclick="x()"/></svg>';

  const clean = sanitiseSvg(dirty);
  assert.ok(!/onload/i.test(clean), 'onload stripped');
  assert.ok(!/onclick/i.test(clean), 'onclick stripped');
  assert.ok(!/elsewhere\.test/.test(clean), 'no external reference survives');
});

test('a doctype that could pull an external DTD is removed', () => {
  const clean = sanitiseSvg(
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>',
  );
  assert.ok(!/DOCTYPE/i.test(clean));
  assert.ok(!/ENTITY/i.test(clean));
});

test('sanitisation refuses markup that is not a usable SVG', () => {
  assert.equal(sanitiseSvg('<html><body>not a logo</body></html>'), '');
  assert.equal(sanitiseSvg(''), '');
  assert.equal(sanitiseSvg(null), '');
  // No viewBox means the artwork has no coordinate system, so it cannot be fitted
  // to the plate and is not returned.
  assert.equal(sanitiseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), '');
  assert.equal(sanitiseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0"/></svg>'), '');
});

/*
 * Logo URLs fail over. An origin that dislikes the request answers 200 with an
 * HTML page, and that page is full of inline icons. Lifting one of those out
 * would put an unrelated, untrusted mark on the cover under the brand's name, so
 * the root element has to be <svg> and not merely appear somewhere in there.
 */
test('an HTML page that happens to contain an inline svg is refused', () => {
  const failover = '<!DOCTYPE html><html><head><title>Bot check</title></head>'
    + '<body><svg viewBox="0 0 24 24"><path fill="#e11d48" d="M0 0h24v24H0z"/></svg></body></html>';
  assert.equal(sanitiseSvg(failover), '');
});

test('a real svg document is still accepted, leading comment or prolog and all', () => {
  const clean = sanitiseSvg(
    '<?xml version="1.0" encoding="utf-8"?><!-- saved from url=(0055)file:///tmp/x.svg -->'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="#38bdf8" d="M0 0h8v8H0z"/></svg>',
  );
  assert.match(clean, /^<svg[\s>]/i, 'the returned markup starts at the root element');
  assert.match(clean, /#38bdf8/);
});

test('a data-URI reference is kept, since it cannot phone home', () => {
  const clean = sanitiseSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
  );
  assert.match(clean, /data:image\/png/);
});

test('tone detection tells a light mark from a dark one', () => {
  assert.deepEqual(svgTone('<svg viewBox="0 0 1 1"><path fill="#ffffff"/></svg>').tone, 'light');
  assert.deepEqual(svgTone('<svg viewBox="0 0 1 1"><path fill="#0f172a"/></svg>').tone, 'dark');
  assert.deepEqual(svgTone('<svg viewBox="0 0 1 1"><path fill="#111"/></svg>').tone, 'dark');
});

test('a gradient is read from its stops, not missed', () => {
  const svg = '<svg viewBox="0 0 1 1"><defs><linearGradient>'
    + '<stop stop-color="#38bdf8"/><stop stop-color="#0f172a"/>'
    + '</linearGradient></defs><rect fill="url(#g)"/></svg>';
  assert.equal(svgTone(svg).swatches, 2, 'both stops counted');
});

test('a currentColor logo is reported as inheriting, not as black', () => {
  // This is the Tailwind case: no fill of its own, so it must not be judged
  // dark and dropped onto a light plate where it would be invisible.
  const { tone } = svgTone('<svg viewBox="0 0 1 1"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>');
  assert.equal(tone, 'inherit');
});

test('style-attribute colours are read as well as presentation attributes', () => {
  const { tone } = svgTone('<svg viewBox="0 0 1 1"><path style="fill:#ffffff"/></svg>');
  assert.equal(tone, 'light');
});

test('"none" and url() paints carry no colour and are not counted', () => {
  const { swatches } = svgTone('<svg viewBox="0 0 1 1"><path fill="none"/><rect fill="url(#g)"/></svg>');
  assert.equal(swatches, 0);
});

test('colour luminance handles hex, shorthand hex and rgb', () => {
  assert.ok(Math.abs(colourLuminance('#ffffff') - 1) < 0.001);
  assert.ok(colourLuminance('#000') < 0.001);
  assert.ok(Math.abs(colourLuminance('rgb(255, 255, 255)') - 1) < 0.001);
  assert.equal(colourLuminance('not-a-colour'), null);
});

/*
 * The surface follows the asset. A white mark on a white page is the same class
 * of bug as the greyscale one, so the plate flips to light when the source was
 * read and measured dark — and only then, because that is the case that would
 * otherwise be invisible.
 */
test('a measured dark mark gets a light plate, everything else keeps the dark one', () => {
  assert.equal(plateIsLight('dark'), true, 'dark mark on a light plate');
  assert.equal(plateIsLight('light'), false, 'white mark on the reference dark plate');
  assert.equal(plateIsLight('inherit'), false, 'currentColor takes the plate ink');
  assert.equal(plateIsLight('unknown'), false, 'no evidence, so the reference default stands');
  assert.equal(plateIsLight(undefined), false, 'a raster logo has no tone at all');
});
