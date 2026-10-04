/**
 * BrandKit server.
 *
 * Four endpoints, each doing genuinely different work on the live site:
 *
 *   POST /api/v1/brand-guide  the complete kit
 *   POST /api/v1/identity     deep CSS forensics and design tokens
 *   POST /api/v1/voice        deep copy analysis and voice guidance
 *   POST /api/v1/compare      multi-brand benchmark
 *
 * Plus GET / for the UI, GET /api/v1/schema, and GET /api/v1/health.
 *
 * Run with: node src/server/index.js
 */

import { createApp } from './http.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TinyFishClient, TinyFishError, describeApiKeySource } from '../tinyfish/client.js';
import { buildBrandGuide } from '../pipeline/brand-guide.js';
import { buildIdentity } from '../pipeline/identity-deep.js';
import { buildVoiceReport } from '../pipeline/voice-deep.js';
import { compareBrands } from '../pipeline/compare.js';
import { render, FORMATS } from '../export/index.js';
import {
  BRAND_GUIDE_SCHEMA, IDENTITY_SCHEMA, VOICE_SCHEMA, COMPARE_SCHEMA, validate,
} from '../schema.js';
import { DEPTHS } from '../pipeline/collect.js';
import { clampPages } from '../lib/page-budget.js';
import { llmInfo } from '../pipeline/llm.js';
import { streamGuide } from './stream.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');
const PORT = Number(process.env.PORT || 3000);

/**
 * One client per request so each response carries its own provenance log.
 * The API key is read from the environment and never leaves it.
 */
function newClient() {
  return new TinyFishClient({ apiKey: process.env.TINYFISH_API_KEY });
}

/** Shared request parsing so all four endpoints behave identically. */
function readRequest(body, query, { requireInput = true } = {}) {
  const input = body?.input ?? body?.url ?? body?.brand ?? query?.input ?? query?.url ?? null;

  if (requireInput && (!input || typeof input !== 'string' || !input.trim())) {
    const err = new Error('Provide "input": a website URL or a company name.');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const depth = body?.depth ?? query?.depth ?? 'standard';
  if (!DEPTHS[depth]) {
    const err = new Error(`Unknown depth "${depth}". Use one of: ${Object.keys(DEPTHS).join(', ')}.`);
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const format = (body?.format ?? query?.format ?? 'json').toLowerCase();
  if (!FORMATS.includes(format)) {
    const err = new Error(`Unknown format "${format}". Use one of: ${FORMATS.join(', ')}.`);
    err.code = 'INVALID_INPUT';
    throw err;
  }

  return {
    input: input?.trim(),
    depth,
    format,
    pages: clampPages(body?.pages ?? query?.pages),
    narrate: body?.narrate ?? query?.narrate !== 'false',
  };
}

/** Send a rendered export instead of JSON when ?format= says so. */
function respond(res, payload, format) {
  if (format === 'json') return payload;

  const rendered = render(format, payload);
  res.writeHead(200, {
    'Content-Type': rendered.contentType,
    'Content-Length': Buffer.byteLength(rendered.body),
    'Content-Disposition': `inline; filename="${rendered.filename}"`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(rendered.body);
  return undefined;
}

/**
 * Serve one source file to the browser as an ES module.
 *
 * The export renderers are pure: they import only from src/lib, which imports
 * nothing at all. That makes them safe to run in a browser, and it means the
 * UI can produce a JSON, CSS or SVG export from the guide it already holds
 * instead of asking the API to re-crawl the site to produce the same bytes.
 *
 * The path list is fixed, never taken from the request, so this is a set of
 * three named routes rather than a static mount.
 */
const MODULES = new Map([
  ['/export/index.js', join(HERE, '..', 'export', 'index.js')],
  ['/lib/tokens.js', join(HERE, '..', 'lib', 'tokens.js')],
  ['/lib/colour.js', join(HERE, '..', 'lib', 'colour.js')],
]);

async function serveModule(url, res) {
  const file = MODULES.get(url.pathname);
  if (!file) return false;

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': body.length,
      // These change whenever the extraction does, so they are never cached
      // across a deploy.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'That module is not served.' } }));
  }
  return true;
}

const routes = [
  {
    method: 'GET',
    pattern: /^\/(?:export\/index|lib\/tokens|lib\/colour)\.js$/,
    handler: async ({ url, res }) => {
      await serveModule(url, res);
      return undefined;
    },
  },
  {
    // Streaming form of the flagship endpoint, used by the UI so each TinyFish
    // call can be shown as it happens rather than after the fact.
    method: 'GET',
    pattern: /^\/api\/v1\/stream$/,
    handler: ({ req, res, url }) => streamGuide(req, res, url),
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/brand-guide$/,
    handler: async ({ body, query, res }) => {
      const req = readRequest(body, query);
      const guide = await buildBrandGuide(newClient(), req.input, {
        depth: req.depth,
        pages: req.pages,
        narrate: req.narrate,
      });
      return respond(res, guide, req.format);
    },
  },
  {
    // The same endpoint over GET, so a guide can be linked to or bookmarked
    // with a format attached. The UI does not use it: it already holds the
    // guide, so exporting in the browser costs no crawl. This exists for
    // curl, a docs link, and anything else that would rather not send a body.
    method: 'GET',
    pattern: /^\/api\/v1\/brand-guide$/,
    handler: async ({ query, res }) => {
      const req = readRequest(null, query);
      const guide = await buildBrandGuide(newClient(), req.input, {
        depth: req.depth,
        pages: req.pages,
        narrate: req.narrate,
      });
      return respond(res, guide, req.format);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/identity$/,
    handler: async ({ body, query, res }) => {
      const req = readRequest(body, query);
      const identity = await buildIdentity(newClient(), req.input, { depth: req.depth });
      return respond(res, identity, req.format);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/voice$/,
    handler: async ({ body, query, res }) => {
      const req = readRequest(body, query);
      const report = await buildVoiceReport(newClient(), req.input, { depth: req.depth, narrate: req.narrate });
      return respond(res, report, req.format);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/compare$/,
    handler: async ({ body, query, res }) => {
      const req = readRequest(body, query);
      const competitors = (body?.competitors ?? body?.against ?? [])
        .flatMap((c) => (Array.isArray(c) ? c : [c]))
        .filter((c) => typeof c === 'string' && c.trim());

      if (competitors.length < 1) {
        const err = new Error('Provide "competitors": an array of one to four company names or URLs.');
        err.code = 'NEEDS_TWO_BRANDS';
        throw err;
      }

      const report = await compareBrands(newClient(), req.input, competitors, { depth: req.depth });
      return respond(res, report, req.format);
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1\/schema$/,
    handler: () => ({
      schemas: {
        'brand-guide': BRAND_GUIDE_SCHEMA,
        identity: IDENTITY_SCHEMA,
        voice: VOICE_SCHEMA,
        compare: COMPARE_SCHEMA,
      },
      formats: FORMATS,
      note: 'The guide object is stable and machine-readable. Every value carries a source; see the provenance block.',
    }),
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1\/health$/,
    handler: async () => {
      const hasKey = Boolean(process.env.TINYFISH_API_KEY);
      const client = newClient();

      // A single cheap Search call proves the key and the upstream both work.
      let upstream = { reachable: false, detail: 'TINYFISH_API_KEY is not set' };
      if (hasKey) {
        const started = Date.now();
        try {
          await client.search('brandkit health check', { purpose: 'Verify the TinyFish API key works before a long crawl.' });
          upstream = { reachable: true, latencyMs: Date.now() - started };
        } catch (err) {
          upstream = { reachable: false, detail: err.message, code: err.code || 'UNKNOWN' };
        }
      }

      return {
        status: upstream.reachable ? 'ok' : 'degraded',
        version: '1.0.0',
        tinyfish: { ...upstream, surfaces: ['search', 'fetch'] },
        llm: llmInfo(),
        endpoints: ['/api/v1/brand-guide', '/api/v1/identity', '/api/v1/voice', '/api/v1/compare'],
        note: 'Search and Fetch are free. The LLM layer is optional and narrates only.',
      };
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1$/,
    handler: () => ({
      name: 'BrandKit',
      description: 'Turn a company name or URL into a structured brand guide, extracted live via TinyFish Search and Fetch.',
      endpoints: {
        'POST /api/v1/brand-guide': 'Complete brand guide: logo, palette, typography, voice, messaging.',
        'POST /api/v1/identity': 'Design tokens, contrast matrix and token graph from the live CSS. Importable into Figma or Tailwind.',
        'POST /api/v1/voice': 'Sentence-level voice analysis, do/don\'t guidance with real quotes, message pillars.',
        'POST /api/v1/compare': 'Benchmark two to five live brands on colour, type, voice and vocabulary.',
      },
      formats: FORMATS,
      schema: '/api/v1/schema',
      health: '/api/v1/health',
    }),
  },
];

const app = createApp(routes, {
  staticRoot: PUBLIC_DIR,
  onError: (err, info) => {
    const label = err instanceof TinyFishError ? `tinyfish:${err.code}` : err.code || 'error';
    // Never log the request body: it can contain a key in some deployments.
    console.error(`[${new Date().toISOString()}] ${info.url} failed after ${info.ms}ms — ${label}: ${err.message}`);
  },
});

app.listen(PORT, () => {
  const key = process.env.TINYFISH_API_KEY;
  const keySource = describeApiKeySource();
  console.log('');
  console.log('  BrandKit — live brand extraction via TinyFish');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log(`  TinyFish API key   ${key ? 'configured' : 'MISSING — set TINYFISH_API_KEY'}`);
  if (keySource.mismatch) {
    console.log('');
    console.log(`  ⚠  ${keySource.message}`);
  }
  const llm = llmInfo();
  if (llm.enabled) {
    console.log(`  LLM narration     enabled · ${llm.provider} · ${llm.model}`);
  } else {
    console.log('  LLM narration     off — deterministic mode');
  }
  if (llm.problem) {
    console.log('');
    console.log(`  ⚠  ${llm.problem}`);
  }
  console.log('');
  console.log('  POST /api/v1/brand-guide   full brand guide');
  console.log('  POST /api/v1/identity      design tokens + contrast');
  console.log('  POST /api/v1/voice         voice and messaging lab');
  console.log('  POST /api/v1/compare       brand benchmark');
  console.log('  GET  /api/v1/schema        JSON Schema');
  console.log('  GET  /api/v1/health        status');
  console.log('');
});

export { app, routes };