/**
 * A very small HTTP layer.
 *
 * Zero dependencies on purpose: the project should run with `node
 * src/server/index.js` on a clean machine, with nothing to install and nothing to
 * audit. Node's built-in server plus a small router is enough.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { readCreds, CRED_HEADER_LIST } from './creds.js';

const MAX_BODY_BYTES = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * @param {Array<{method:string, pattern:RegExp, handler:Function}>} routes
 * @param {{ staticRoot?: string, onError?: Function }} [opts]
 */
export function createApp(routes, opts = {}) {
  const compiled = routes.map((route) => ({
    ...route,
    keys: route.keys || [],
  }));

  return createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: { code: 'BAD_URL', message: 'Malformed request URL.' } });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // The API is public and read-only; allow any origin to call it. Credentials
    // ride in headers, so those have to be named on the preflight too.
    if (url.pathname.startsWith('/api/') || req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${CRED_HEADER_LIST}`);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return undefined;
    }

    for (const route of compiled) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;

      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : null;
        const params = Object.fromEntries(
          route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]),
        );
        const result = await route.handler({
          req,
          res,
          url,
          params,
          query: Object.fromEntries(url.searchParams),
          body,
          // Read once per request and handed to every handler: the key belongs to
          // this call only, so nothing downstream can outlive it.
          creds: readCreds(req),
        });
        if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
      } catch (err) {
        if (opts.onError) opts.onError(err, { url: url.pathname, ms: Date.now() - started });
        sendError(res, err);
      }
      return undefined;
    }

    // An unmatched path under /api/ is a mistyped endpoint, not a client route. The
    // SPA fallback would answer it with the app shell and a 200, so a caller
    // expecting JSON would never learn the route is gone.
    if (req.method === 'GET' && opts.staticRoot && !url.pathname.startsWith('/api/')) {
      return serveStatic(opts.staticRoot, url.pathname, res);
    }

    return sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${url.pathname}. See GET /api/v1 for the API surface.`,
      },
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body is too large.');
      err.code = 'BODY_TOO_LARGE';
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Request body is not valid JSON.');
    err.code = 'INVALID_JSON';
    err.status = 400;
    throw err;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** Uniform error envelope, with TinyFish's own codes preserved. */
function sendError(res, err) {
  const status = err.status || statusForCode(err.code);
  sendJson(res, status, {
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Something went wrong.',
      ...(err.requestId ? { requestId: err.requestId } : {}),
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.url ? { url: err.url } : {}),
    },
  });
}

function statusForCode(code) {
  switch (code) {
    // A missing key is now the caller's own, sent per request, so it is their
    // mistake to fix. It used to be a deployment fault and a 500.
    case 'MISSING_API_KEY':
      return 400;
    // A key that was sent and rejected is still our side talking to the wrong
    // account, and a 4xx would tell the caller their URL or input is at fault.
    case 'INVALID_API_KEY':
    // These are upstream failures: our key or the connection is broken, so *no*
    // site can be read. Reporting them as 4xx would wrongly tell the caller to
    // fix their input.
    case 'UNAUTHENTICATED':
    case 'HTTP_401':
    case 'HTTP_403':
    case 'NETWORK_ERROR':
    case 'UPSTREAM_TIMEOUT':
      return 500;
    case 'INVALID_INPUT':
    case 'INVALID_URL':
    case 'INVALID_HOST':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_SCHEME':
    case 'NEEDS_TWO_BRANDS':
      return 400;
    case 'PRIVATE_ADDRESS':
      return 400;
    case 'BODY_TOO_LARGE':
      return 413;
    case 'NO_DOMAIN_FOUND':
    case 'NO_READABLE_CONTENT':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 502;
  }
}

async function serveStatic(root, pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(root, relative));
  if (!target.startsWith(root + sep) && target !== join(root, 'index.html')) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Path traversal is not allowed.' } });
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  } catch {
    // Unknown path: hand back the single-page app so client routing works.
    try {
      const shell = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': shell.length });
      return res.end(shell);
    } catch {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    }
  }
}