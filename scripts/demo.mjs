#!/usr/bin/env node
/**
 * Demo run.
 *
 * Proves the bounty criteria on three deliberately different kinds of site and
 * writes the evidence to disk:
 *
 *   1. a JavaScript-heavy app with a large Tailwind design system
 *   2. a hand-rolled government site with no framework and thin metadata
 *   3. a consumer brand built around imagery
 *
 * Nothing about these three is special-cased anywhere in the code. Change the
 * list and the same pipeline runs.
 *
 *   node scripts/demo.mjs
 *   node scripts/demo.mjs --only linear
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TinyFishClient } from '../src/tinyfish/client.js';
import { buildBrandGuide } from '../src/pipeline/brand-guide.js';
import { compareBrands } from '../src/pipeline/compare.js';
import { render } from '../src/export/index.js';
import { validate, BRAND_GUIDE_SCHEMA } from '../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'demo-output');

/**
 * Chosen to break naive extractors, not because they are flattering subjects.
 * - linear: 49 stylesheets, opaque build hashes, brand tokens in one late file
 * - GOV.UK: no framework, no CSS custom properties, thick default type
 * - patagonia: image-led, sparse CSS tokens, retail palette
 */
const BRANDS = [
  { name: 'Linear', input: 'linear', note: 'JS-heavy SPA, Tailwind v4 tokens, 49 stylesheets' },
  { name: 'GOV.UK', input: 'www.gov.uk', note: 'Hand-rolled CSS, no custom properties, thin metadata' },
  { name: 'Patagonia', input: 'patagonia.com', note: 'Image-led consumer brand, sparse CSS tokens' },
];

const COMPARE_SET = ['linear', 'notion', 'asana'];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function hr(label) {
  process.stdout.write(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}\n`);
}

async function main() {
  const apiKey = process.env.TINYFISH_API_KEY || '';
  if (!apiKey) {
    process.stderr.write('\nNo TinyFish key. Set TINYFISH_API_KEY for this run, or create a free one at https://agent.tinyfish.ai/api-keys\n\n');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });

  const brands = only ? BRANDS.filter((b) => b.name.toLowerCase().includes(only.toLowerCase())) : BRANDS;
  if (!brands.length) {
    process.stderr.write(`No demo brand matches "${only}".\n`);
    process.exit(1);
  }

  const summary = [];

  for (const brand of brands) {
    hr(`BRAND GUIDE — ${brand.name}  (${brand.note})`);
    const client = new TinyFishClient({
      apiKey,
      onCall: (call) => {
        const label = String(call.label).slice(0, 46).padEnd(46);
        process.stdout.write(`  ${label} ${String(call.durationMs).padStart(6)}ms  ${call.surface}\n`);
      },
    });

    const started = Date.now();
    let guide;
    try {
      guide = await buildBrandGuide(client, brand.input, { depth: 'standard', narrate: false });
    } catch (err) {
      process.stdout.write(`\n  FAILED: ${err.message}\n`);
      summary.push({ brand: brand.name, ok: false, error: err.message });
      continue;
    }
    const elapsed = Date.now() - started;

    // 1. Schema self-check: the output must satisfy the published contract.
    const schemaErrors = validate(guide, BRAND_GUIDE_SCHEMA);

    // 2. Accuracy spot checks, printed so they can be verified by hand.
    printGuideSummary(guide, elapsed);

    // 3. Write every export format.
    const dir = join(OUT, slug(brand.name));
    await mkdir(dir, { recursive: true });
    const files = {};
    for (const format of ['json', 'markdown', 'css', 'tailwind', 'styledictionary', 'figma', 'svg']) {
      const rendered = render(format, guide);
      files[format] = rendered.filename;
      await writeFile(join(dir, rendered.filename), rendered.body, 'utf8');
    }

    summary.push({
      brand: brand.name,
      ok: true,
      url: guide.identity.url,
      confidence: guide.confidence.overall,
      schemaValid: schemaErrors.length === 0,
      schemaErrors: schemaErrors.slice(0, 5),
      colours: guide.colors.tokens.length,
      typefaces: guide.typography.families.length,
      pagesRead: guide.provenance.pagesRead.length,
      stylesheets: guide.provenance.stylesheetsRead.length,
      calls: guide.provenance.tinyfish.totalCalls,
      seconds: Math.round(elapsed / 100) / 10,
      files,
    });

    process.stdout.write(`\n  schema: ${schemaErrors.length === 0 ? 'valid' : `INVALID — ${schemaErrors.join('; ')}`}\n`);
    process.stdout.write(`  wrote ${Object.keys(files).length} files to demo-output/${slug(brand.name)}/\n`);
  }

  // The compare endpoint, on the full set.
  if (brands.length > 1 && !only) {
    hr('COMPARE — Linear vs Notion vs Asana');
    try {
      const compare = await compareBrands(new TinyFishClient(), 'linear', COMPARE_SET.slice(1), { depth: 'quick' });
      await writeFile(join(OUT, 'compare.json'), JSON.stringify(compare, null, 2), 'utf8');
      for (const brand of compare.brands) {
        const swatches = (brand.palette || []).map((p) => p.hex).join(' ');
        process.stdout.write(`  ${brand.name.padEnd(10)} ${String(brand.ok).padEnd(6)} ${swatches}\n`);
      }
      process.stdout.write('\n');
      for (const row of compare.comparison?.rows || []) {
        process.stdout.write(
          `  vs ${row.against.padEnd(8)} distinctiveness ${String(row.distinctiveness.score).padStart(3)}  ${row.palette.reading}, ${row.tone.reading}\n`,
        );
      }
      if (compare.positioning?.owned?.terms?.length) {
        process.stdout.write(`\n  vocabulary Linear owns: ${compare.positioning.owned.terms.join(', ')}\n`);
      }
    } catch (err) {
      process.stdout.write(`  FAILED: ${err.message}\n`);
    }
  }

  hr('SUMMARY');
  for (const row of summary) {
    if (!row.ok) {
      process.stdout.write(`  ${row.brand.padEnd(12)} FAILED — ${row.error}\n`);
      continue;
    }
    process.stdout.write(
      `  ${row.brand.padEnd(12)} ${String(row.confidence).padEnd(5)} confidence  ` +
      `${String(row.colours).padStart(2)} colours  ${String(row.typefaces).padStart(2)} typefaces  ` +
      `${String(row.pagesRead).padStart(2)} pages  ${String(row.stylesheets).padStart(2)} stylesheets  ` +
      `${String(row.calls).padStart(2)} TinyFish calls  ${String(row.seconds).padStart(5)}s  ` +
      `schema ${row.schemaValid ? 'valid' : 'INVALID'}\n`,
    );
  }
  process.stdout.write(`\n  Output written to demo-output/\n\n`);
}

function printGuideSummary(guide, elapsed) {
  const roles = guide.colors.roles;
  process.stdout.write('\n');
  process.stdout.write(`  ${guide.identity.name} — ${guide.identity.url}\n`);
  if (guide.identity.tagline) process.stdout.write(`  tagline: ${guide.identity.tagline}\n`);
  process.stdout.write(`\n  LOGO    ${guide.logos.primary ? `${guide.logos.primary.format.toUpperCase()} ${guide.logos.primary.type}` : 'none verified'}\n`);
  if (guide.logos.primary) process.stdout.write(`          ${guide.logos.primary.url}\n`);

  process.stdout.write('\n  COLOUR\n');
  for (const role of ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted', 'border', 'onPrimary', 'success', 'warning', 'error']) {
    const hex = roles[role];
    if (!hex) continue;
    const mark = roles.inferred?.includes(role) ? '(inferred)' : '';
    process.stdout.write(`    ${role.padEnd(12)} ${hex}  ${mark}\n`);
  }
  process.stdout.write(`    theme-color declared by the site: ${roles.declaredThemeColor || 'none'}\n`);

  process.stdout.write('\n  TYPEFACE\n');
  process.stdout.write(`    headings ${guide.typography.pairing.heading || '—'}\n`);
  process.stdout.write(`    body     ${guide.typography.pairing.body || '—'}\n`);
  process.stdout.write(`    mono     ${guide.typography.pairing.mono || '—'}\n`);
  process.stdout.write(`    ${guide.typography.source.method}\n`);

  if (guide.voice.ok) {
    process.stdout.write('\n  VOICE\n');
    process.stdout.write(`    ${guide.voice.sentencesAnalysed} sentences · ${guide.voice.pagesAnalysed} pages · consistency ${guide.voice.consistency.grade}\n`);
    for (const d of guide.voice.descriptors) {
      process.stdout.write(`    ${d.axis.padEnd(18)} ${d.value}\n`);
    }
  }

  if (guide.messaging.taglines?.length) {
    process.stdout.write('\n  MESSAGING\n');
    for (const tagline of guide.messaging.taglines.slice(0, 3)) {
      process.stdout.write(`    "${tagline.text}"  (${tagline.kind})\n`);
    }
    const pillars = (guide.messaging.pillars || []).slice(0, 3).map((p) => p.name).join(', ');
    if (pillars) process.stdout.write(`    pillars: ${pillars}\n`);
  }

  process.stdout.write(`\n  ${guide.provenance.tinyfish.totalCalls} TinyFish calls · ${guide.provenance.pagesRead.length} pages · ${guide.provenance.stylesheetsRead.length} stylesheets · ${(elapsed / 1000).toFixed(1)}s\n`);
}

main().catch((err) => {
  process.stderr.write(`\n${err.stack || err.message}\n`);
  process.exit(1);
});