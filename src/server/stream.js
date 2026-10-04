/**
 * Server-sent events for a single brand-guide run.
 *
 * GET /api/v1/stream?input=linear&depth=standard
 *
 * The point is legibility, not speed: a brand extraction is several seconds of
 * TinyFish traffic, and watching each call land is the clearest possible proof
 * that a real crawl is happening rather than a canned response.
 *
 * Frames:
 *   event: stage   { stage, status, ... }   pipeline progress
 *   event: call    TinyFish request finished (surface, label, latency, urls)
 *   event: done    { guide }                 full payload
 *   event: error   { code, message }
 */

import { TinyFishClient } from '../tinyfish/client.js';
import { buildBrandGuide } from '../pipeline/brand-guide.js';
import { DEPTHS } from '../pipeline/collect.js';
import { clampPages } from '../lib/page-budget.js';

export async function streamGuide(req, res, url) {
  const input = (url.searchParams.get('input') || '').trim();
  if (!input) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Pass ?input=<url or company name>.' } }));
    return;
  }

  const depth = DEPTHS[url.searchParams.get('depth')] ? url.searchParams.get('depth') : 'standard';

  // How many pages the rendered guide should have. This is a budget for the
  // optional narration layer, not a promise: a brand whose live data supports
  // fewer pages returns fewer, and the deck reports the shortfall.
  const requestedPages = clampPages(url.searchParams.get('pages'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeats proxy buffering, which would otherwise hide the whole point.
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep intermediaries from closing an idle connection during a slow fetch.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  let client;
  try {
    client = new TinyFishClient({
      apiKey: process.env.TINYFISH_API_KEY,
      onCall: (call) => {
        send('call', {
          id: call.id,
          surface: call.surface,
          label: call.label,
          durationMs: call.durationMs,
          okUrls: call.okUrls ?? null,
          errorCount: call.errorCount ?? null,
          format: call.meta?.format ?? null,
          selectors: call.meta?.include_selectors ?? null,
          urls: call.meta?.urls?.slice(0, 3) ?? null,
          failed: Boolean(call.failed),
        });
      },
    });

    const guide = await buildBrandGuide(client, input, {
      depth,
      pages: requestedPages,
      narrate: url.searchParams.get('narrate') !== 'false',
      onProgress: (event) => send('stage', event),
    });

    send('done', guide);
  } catch (err) {
    send('error', { code: err.code || 'INTERNAL_ERROR', message: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}