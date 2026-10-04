#!/usr/bin/env node
/**
 * BrandKit CLI.
 *
 * Runs an extraction and writes the result to stdout or to a file. Useful for
 * scripting the API without a server running.
 *
 *   node src/cli.js linear
 *   node src/cli.js linear --format markdown -o linear.md
 *   node src/cli.js linear --depth deep
 *   node src/cli.js compare --competitors notion,asana
 *   node src/cli.js identity linear.app
 *   node src/cli.js voice linear.app
 *   node src/cli.js health
 */

import { writeFile } from 'node:fs/promises';

import { TinyFishClient, TinyFishError, describeApiKeySource } from './tinyfish/client.js';
import { buildBrandGuide } from './pipeline/brand-guide.js';
import { buildIdentity } from './pipeline/identity-deep.js';
import { buildVoiceReport } from './pipeline/voice-deep.js';
import { compareBrands } from './pipeline/compare.js';
import { render, FORMATS } from './export/index.js';
import { llmInfo } from './pipeline/llm.js';

const HELP = `
BrandKit — turn a company name or URL into a structured brand guide.

Usage
  node src/cli.js <command> <input> [options]

Commands
  guide <input>        Full brand guide: logo, palette, type, voice, messaging
  identity <input>     Design tokens, token graph and contrast matrix
  voice <input>        Sentence-level voice analysis and messaging pillars
  compare <input>      Benchmark against --competitors (2 to 5 brands)
  health               Check that the TinyFish key and upstream are working

Options
  --format <fmt>       ${FORMATS.join(' | ')}            (default: json)
  --depth <depth>      quick | standard | deep         (default: standard)
  --competitors <csv>  Comma-separated brands, required by compare
  --no-narrate         Skip the optional LLM interpretation layer
  -o, --out <file>     Write to a file instead of stdout
  -h, --help           Show this message

Input can be a URL ("linear.app", "https://linear.app") or a company name
("linear"). Names are resolved with TinyFish Search.

Everything is read live through TinyFish Search and Fetch. Nothing is stored.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') args.out = argv[++i];
    else if (arg === '--format') args.format = argv[++i];
    else if (arg === '--depth') args.depth = argv[++i];
    else if (arg === '--competitors') args.competitors = argv[++i];
    else if (arg === '--no-narrate') args.narrate = false;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg.startsWith('-')) args[arg.replace(/^--?/, '')] = true;
    else args._.push(arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args._.length) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  if (!process.env.TINYFISH_API_KEY) {
    fail('TINYFISH_API_KEY is not set. Create a key at https://agent.tinyfish.ai/api-keys');
  }

  // A stale exported key silently beats the one in .env; say so before a long
  // crawl fails with a 401 that looks like the site blocking us.
  const keySource = describeApiKeySource();
  if (keySource.mismatch) {
    process.stderr.write(`\n⚠  ${keySource.message}\n\n`);
  }

  const command = args._[0];
  const input = args._[1];
  const format = (args.format || 'json').toLowerCase();

  if (!FORMATS.includes(format)) {
    fail(`Unknown format "${format}". Use one of: ${FORMATS.join(', ')}.`);
  }
  if (!['quick', 'standard', 'deep'].includes(args.depth || 'standard')) {
    fail('Unknown depth. Use quick, standard or deep.');
  }

  const options = { depth: args.depth || 'standard', narrate: args.narrate !== false };

  if (command === 'health') {
    const client = new TinyFishClient();
    const started = Date.now();
    try {
      await client.search('brandkit health check', { purpose: 'Verify the TinyFish API key works.' });
      report({ status: 'ok', tinyfish: { reachable: true, latencyMs: Date.now() - started }, llm: llmInfo() });
    } catch (err) {
      report({ status: 'degraded', error: err.message, llm: llmInfo() });
      process.exitCode = 1;
    }
    return;
  }

  if (!input) fail(`The "${command}" command needs an input: a URL or a company name.`);

  // A per-run client so the provenance log belongs to this extraction alone.
  const client = new TinyFishClient({
    onCall: (call) => {
      process.stderr.write(
        `  ${call.surface.padEnd(6)} ${String(call.label).padEnd(34)} ${String(call.durationMs).padStart(6)}ms\n`,
      );
    },
  });

  process.stderr.write(`\nBrandKit · ${command} · ${input}\n\n`);

  let payload;
  switch (command) {
    case 'guide':
      payload = await buildBrandGuide(client, input, options);
      break;
    case 'identity':
      payload = await buildIdentity(client, input, { depth: options.depth });
      break;
    case 'voice':
      payload = await buildVoiceReport(client, input, options);
      break;
    case 'compare': {
      const competitors = String(args.competitors || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (competitors.length < 1) fail('compare needs --competitors with at least one brand.');
      payload = await compareBrands(client, input, competitors, options);
      break;
    }
    default:
      fail(`Unknown command "${command}". Run with --help for the list.`);
  }

  const rendered = render(format, payload);

  if (args.out) {
    await writeFile(args.out, rendered.body, 'utf8');
    process.stderr.write(`\nWrote ${args.out} (${rendered.body.length.toLocaleString()} bytes)\n`);
  } else {
    process.stdout.write(rendered.body.endsWith('\n') ? rendered.body : `${rendered.body}\n`);
  }

  if (payload.warnings?.length) {
    process.stderr.write(`\nNotes:\n${payload.warnings.map((w) => `  - ${w}`).join('\n')}\n`);
  }
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof TinyFishError) {
    process.stderr.write(`\nTinyFish error [${err.code}]\n${err.message}\n`);
    if (err.requestId) process.stderr.write(`request id: ${err.requestId}\n`);
  } else {
    process.stderr.write(`\n${err.message}\n`);
  }
  process.exit(1);
});