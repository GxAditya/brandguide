#!/usr/bin/env node
/**
 * BrandKit CLI: runs an extraction and writes the result to stdout or a file, so
 * the API can be scripted without a server running.
 *
 *   node src/cli.js guide linear --key sk-tinyfish-... --format markdown
 *   node src/cli.js compare linear --key sk-... --competitors notion,asana
 *   node src/cli.js health --key sk-tinyfish-...
 *
 * Keys are passed in rather than read from the environment, so a shell history,
 * a CI log or a stray exported variable can never end up holding one.
 */

import { writeFile } from 'node:fs/promises';

import { TinyFishClient, TinyFishError } from './tinyfish/client.js';
import { buildBrandGuide } from './pipeline/brand-guide.js';
import { compareBrands } from './pipeline/compare.js';
import { render, FORMATS } from './export/index.js';
import { llmInfo } from './pipeline/llm.js';

const HELP = `
BrandKit — turn a company name or URL into a structured brand guide.

Usage
  node src/cli.js <command> <input> [options]

Commands
  guide <input>        Full brand guide: logo, palette, type, voice, messaging
  compare <input>      Benchmark against --competitors (2 to 5 brands)
  health               Verify the TinyFish key passed with --key

Required
  --key <key>          Your TinyFish API key, free at https://agent.tinyfish.ai/api-keys

Options
  --format <fmt>       ${FORMATS.join(' | ')}            (default: json)
  --depth <depth>      quick | standard | deep         (default: standard)
  --competitors <csv>  Comma-separated brands, required by compare
  --no-narrate         Skip the optional LLM interpretation layer
  -o, --out <file>     Write to a file instead of stdout
  -h, --help           Show this message

Optional narration layer. Without these the deterministic core runs, which is the
recommended mode: no key, no spend, and the measured pages are produced anyway.

  --llm-preset <id>    gemini | openrouter | groq | nvidia | openai | cerebras
                       | mistral | deepseek | custom
                       Supplies the base URL and a working model
  --llm-key <key>      Narration key
  --llm <transport>    gemini | openai. Overrides the preset's transport
  --llm-base <url>     Base URL. Only needed with --llm-preset custom
  --llm-model <id>     Model id. Optional: another model is tried when this one is
                       unavailable or over its rate limit

Free tiers, so --llm-preset with just a key is enough:
  gemini      20 requests/day per model, moves to another model when full
  openrouter  16 free models, all ending :free
  groq        fast, free developer tier
  nvidia      free hosted models; retired ones answer 410 Gone

Input can be a URL ("linear.app", "https://linear.app") or a company name
("linear"). Names are resolved with TinyFish Search.

Everything is read live through TinyFish Search and Fetch. Nothing is stored.
`;

/**
 * Map the narration flags onto the credential shape the pipeline reads.
 *
 * `--llm-preset` is the useful one: it supplies the base URL and a working model, so
 * scripting a free provider needs a key and a name rather than three exact values.
 */
function llmCreds(args) {
  if (!args['llm-key']) return {};

  const preset = args['llm-preset'] ? String(args['llm-preset']).toLowerCase() : '';
  const provider = args.llm ? String(args.llm).toLowerCase() : preset;
  const key = args['llm-key'];
  const base = args['llm-base'] ? String(args['llm-base']) : '';
  const model = args['llm-model'] ? String(args['llm-model']) : '';

  // A preset, or an explicit `--llm gemini`, means the Gemini transport.
  if (provider === 'gemini' || (preset && preset === 'gemini')) {
    return {
      GEMINI_API_KEY: key,
      ...(preset ? { LLM_PRESET: preset } : {}),
      ...(model ? { GEMINI_MODEL: model } : {}),
    };
  }

  return {
    ...(provider ? { LLM_PROVIDER: 'openai-compatible' } : {}),
    LLM_API_KEY: key,
    ...(preset ? { LLM_PRESET: preset } : {}),
    ...(base ? { LLM_BASE_URL: base } : {}),
    ...(model ? { LLM_MODEL: model } : {}),
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') args.out = argv[++i];
    else if (arg === '--key') args.key = argv[++i];
    else if (arg === '--llm') args.llm = argv[++i];
    else if (arg === '--llm-preset') args['llm-preset'] = argv[++i];
    else if (arg === '--llm-key') args['llm-key'] = argv[++i];
    else if (arg === '--llm-base') args['llm-base'] = argv[++i];
    else if (arg === '--llm-model') args['llm-model'] = argv[++i];
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

  const apiKey = typeof args.key === 'string' ? args.key.trim() : '';
  if (!apiKey) {
    fail('No TinyFish key. Pass one with --key. Create a free key at https://agent.tinyfish.ai/api-keys');
  }

  const command = args._[0];
  const input = args._[1];
  const format = (args.format || 'json').toLowerCase();
  const creds = llmCreds(args);

  if (!FORMATS.includes(format)) {
    fail(`Unknown format "${format}". Use one of: ${FORMATS.join(', ')}.`);
  }
  if (!['quick', 'standard', 'deep'].includes(args.depth || 'standard')) {
    fail('Unknown depth. Use quick, standard or deep.');
  }

  const options = { depth: args.depth || 'standard', narrate: args.narrate !== false, creds };

  if (command === 'health') {
    // The one place the CLI is allowed to spend a call proving a key works. The
    // HTTP /health endpoint deliberately does not do this.
    const client = new TinyFishClient({ apiKey });
    const started = Date.now();
    try {
      await client.search('brandkit health check', { purpose: 'Verify the TinyFish API key works.' });
      report({ status: 'ok', tinyfish: { reachable: true, latencyMs: Date.now() - started }, llm: llmInfo(creds) });
    } catch (err) {
      report({ status: 'degraded', error: err.message, llm: llmInfo(creds) });
      process.exitCode = 1;
    }
    return;
  }

  if (!input) fail(`The "${command}" command needs an input: a URL or a company name.`);

  // A per-run client so the provenance log belongs to this extraction alone.
  const client = new TinyFishClient({
    apiKey,
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