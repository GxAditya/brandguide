/**
 * BrandKit server.
 *
 *   POST /api/v1/brand-guide  the complete kit
 *   POST /api/v1/compare      multi-brand benchmark
 *
 * plus GET /api/v1/stream (SSE), GET /api/v1/health, GET /api/v1 and GET / for
 * the UI.
 *
 * The server holds no credentials. Every request carries the caller's own keys in
 * X-BrandKit-* headers; see src/server/creds.js. Nothing here reads a key from the
 * environment, so a deployment is a public URL and nothing else.
 *
 * Run with: node src/server/index.js
 */

import { createApp } from './http.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TinyFishClient, TinyFishError } from '../tinyfish/client.js';
import { buildBrandGuide } from '../pipeline/brand-guide.js';
import { compareBrands } from '../pipeline/compare.js';
import { render, FORMATS } from '../export/index.js';
import { DEPTHS } from '../pipeline/collect.js';
import { clampPages } from '../lib/page-budget.js';
import { resolveLlm } from '../pipeline/llm-provider.js';
import { callGemini } from '../pipeline/llm-gemini.js';
import { callOpenAiCompatible } from '../pipeline/llm-openai.js';
import { PRESETS } from '../pipeline/llm-presets.js';
import { streamGuide } from './stream.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');
const PORT = Number(process.env.PORT || 3000);

/** One client per request, so each response carries its own provenance log. */
function newClient(creds) {
  return new TinyFishClient({ apiKey: creds.tinyfishKey });
}

/** The transport for whichever provider the caller resolved to. */
function callLlm(prompt, config) {
  return config.provider === 'gemini' ? callGemini(prompt, config) : callOpenAiCompatible(prompt, config);
}

/** Shared request parsing so both endpoints behave identically. */
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
 * Serve one source file to the browser as an ES module. The export renderers are
 * pure, so the UI can export from the guide it already holds instead of asking the
 * API to re-crawl for the same bytes. The path list is fixed, never from the request.
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
    method: 'GET',
    pattern: /^\/api\/v1\/stream$/,
    handler: ({ res, url, creds }) => streamGuide(creds, res, url),
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/brand-guide$/,
    handler: async ({ body, query, res, creds }) => {
      const req = readRequest(body, query);
      const guide = await buildBrandGuide(newClient(creds), req.input, {
        depth: req.depth,
        pages: req.pages,
        narrate: req.narrate,
        creds: creds.llm,
      });
      return respond(res, guide, req.format);
    },
  },
  {
    // The same endpoint over GET, so a guide can be linked to with a format
    // attached. The UI does not use it: it already holds the guide, so exporting
    // in the browser costs no crawl. This is for curl and docs links.
    method: 'GET',
    pattern: /^\/api\/v1\/brand-guide$/,
    handler: async ({ query, res, creds }) => {
      const req = readRequest(null, query);
      const guide = await buildBrandGuide(newClient(creds), req.input, {
        depth: req.depth,
        pages: req.pages,
        narrate: req.narrate,
        creds: creds.llm,
      });
      return respond(res, guide, req.format);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/compare$/,
    handler: async ({ body, query, res, creds }) => {
      const req = readRequest(body, query);
      const competitors = (body?.competitors ?? body?.against ?? [])
        .flatMap((c) => (Array.isArray(c) ? c : [c]))
        .filter((c) => typeof c === 'string' && c.trim());

      if (competitors.length < 1) {
        const err = new Error('Provide "competitors": an array of one to four company names or URLs.');
        err.code = 'NEEDS_TWO_BRANDS';
        throw err;
      }

      const report = await compareBrands(newClient(creds), req.input, competitors, {
        depth: req.depth,
        creds: creds.llm,
      });
      return respond(res, report, req.format);
    },
  },

  {
    /**
     * Liveness only, and deliberately free of any upstream call.
     *
     * It used to fire a TinyFish Search to prove the key worked, which made it a
     * credential test wearing a health check's name: a platform probing it every
     * thirty seconds would spend real quota, and a slow upstream would report a
     * healthy process as unhealthy. Nothing here touches the network, so it says
     * only what this process can answer: that it is up, and how long it has been.
     * Whether a caller's key works is a per-request answer, returned by the run
     * that used it.
     */
    method: 'GET',
    pattern: /^\/api\/v1\/health$/,
    handler: async () => ({
      status: 'ok',
      version: '1.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      auth: 'byok',
      credentials: {
        transport: 'headers',
        tinyfish: 'x-brandkit-tinyfish-key',
        llm: [
          'x-brandkit-llm-preset',
          'x-brandkit-llm-provider',
          'x-brandkit-llm-key',
          'x-brandkit-llm-base',
          'x-brandkit-llm-model',
        ],
      },
      endpoints: ['/api/v1/brand-guide', '/api/v1/compare', '/api/v1/stream', '/api/v1/llm-check'],
      note: 'This server holds no keys and makes no upstream call here. Send your own key with a request.',
    }),
  },

  {
    /**
     * Check a narration credential with one tiny call, so Settings can say whether a
     * key works before a 25-second crawl is spent finding out.
     *
     * Deliberately the cheapest possible request: one short prompt, the smallest
     * model the preset offers. It answers "is this key good and does this provider
     * have capacity right now", which is the question a person opening Settings has.
     * Anything richer would cost the caller quota to answer it.
     */
    method: 'POST',
    pattern: /^\/api\/v1\/llm-check$/,
    handler: async ({ body, creds }) => {
      const config = resolveLlm(creds.llm);
      if (!config.configured) {
        return { ok: false, reason: config.problem || 'no narration key supplied' };
      }

      const started = Date.now();
      try {
        const text = await callLlm(
          { system: 'Reply with the single word OK.', user: 'Reply with the single word OK.' },
          config,
        );
        return {
          ok: Boolean(text),
          provider: config.provider,
          model: config.model,
          endpoint: config.endpoint,
          latencyMs: Date.now() - started,
          ...(text ? {} : { reason: 'The provider answered with no text.' }),
        };
      } catch (err) {
        // The transport's own message already names the model, the limit and the fix.
        return {
          ok: false,
          provider: config.provider,
          model: config.model,
          endpoint: config.endpoint,
          latencyMs: Date.now() - started,
          reason: err.message,
        };
      }
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/v1$/,
    handler: () => ({
      name: 'BrandKit',
      description: 'Turn a company name or URL into a structured brand guide, extracted live via TinyFish Search and Fetch.',
      auth: {
        mode: 'byok',
        note: 'No key is stored. Send your own per request in headers; see /api/v1/health for the names.',
        required: ['x-brandkit-tinyfish-key'],
        optional: ['x-brandkit-llm-preset', 'x-brandkit-llm-provider', 'x-brandkit-llm-key', 'x-brandkit-llm-base', 'x-brandkit-llm-model'],
      },
      /**
       * The preset catalogue, so the Settings panel and any other client read the same
       * list rather than each hard-coding a base URL. Free tiers come first: they are
       * the ones a visitor can actually use without a payment method.
       */
      presets: PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        transport: p.transport,
        free: Boolean(p.free),
        baseUrl: p.baseUrl || null,
        hint: p.hint,
        keyUrl: p.keyUrl || null,
        models: p.models || [],
      })),
      llmCheck: {
        method: 'POST',
        path: '/api/v1/llm-check',
        note: 'Sends one minimal prompt with your narration headers and reports whether the key works. Costs one request from your quota.',
      },
      endpoints: {
        'POST /api/v1/brand-guide': 'Complete brand guide: logo, palette, typography, voice, messaging.',
        'POST /api/v1/compare': 'Benchmark two to five live brands on colour, type, voice and vocabulary.',
      },
      formats: FORMATS,
      schema: 'The guide is validated against BRAND_GUIDE_SCHEMA on every demo run.',
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
  console.log('');
  console.log('  BrandKit — live brand extraction via TinyFish');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  TinyFish API key   supplied per request — this server stores none');
  console.log('  LLM narration      supplied per request — optional, narrates only');
  console.log('');
  console.log('  POST /api/v1/brand-guide   full brand guide');
  console.log('  POST /api/v1/compare       brand benchmark');
  console.log('  GET  /api/v1/stream        live progress (SSE)');
  console.log('  GET  /api/v1/health        liveness');
  console.log('');
});