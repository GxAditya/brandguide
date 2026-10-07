/**
 * The fallback ladder, proved rather than asserted: a caller who names a model that
 * is over capacity must still get a narrative, from another model.
 *
 * A mock is used because the real free tier's capacity is not something a test can
 * depend on. It answers 429 with a long retry-after for one model and 200 for the rest,
 * which is exactly the situation that used to produce a silent deterministic guide.
 */
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLlm } from '../src/pipeline/llm-provider.js';
import { callGemini } from '../src/pipeline/llm-gemini.js';
import { callOpenAiCompatible } from '../src/pipeline/llm-openai.js';
import { narrate } from '../src/pipeline/llm.js';
import { PRESETS, GEMINI_FALLBACKS, GEMINI_MODELS, LIMITS } from '../src/pipeline/llm-presets.js';

const FACTS = {
  identity: { name: 'Acme', domain: 'acme.test' },
  colors: { tokens: [{ name: 'ink', hex: '#111111' }] },
  typography: { families: [{ family: 'Inter', kind: 'sans', role: 'body' }] },
  voice: {
    vector: { formality: 0.6 },
    raw: {},
    descriptors: [{ axis: 'formality', value: 'medium', note: 'n' }],
    signalSentences: [{ text: 'Ship the thing.' }],
  },
  messaging: { headlines: [{ text: 'Acme builds the thing' }], claims: [], positioning: null },
};

const REPLY = JSON.stringify({
  toneSummary: 'Direct and plain.',
  positioning: 'A positioning line.',
  pillars: [{ name: 'Speed', claim: 'Ships faster.', evidence: 'Ship the thing.' }],
  doNext: ['Keep it short'],
  watchOuts: ['No jargon'],
});

/** A Gemini-shaped server that can throttle or retire specific models. */
async function geminiMock({ throttled = [], gone = [], reply = REPLY } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ model: body.model });

      if (gone.includes(body.model)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }

      if (throttled.includes(body.model)) {
        // The daily-limit shape: a retry-after measured in hours.
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '28800' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded for model ' + body.model } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: reply }] }],
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/v1beta`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** An OpenAI-shaped server that refuses the fullest body and accepts a smaller one. */
async function openAiMock({ rejectFirst = true } = {}) {
  const seen = [];
  let first = true;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);

      if (rejectFirst && first) {
        first = false;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ── The model ladder ─────────────────────────────────────────────────────── */

test('a rate-limited model does not end the run: another model answers', async () => {
  const mock = await geminiMock({ throttled: ['gemini-3.1-flash-lite'] });
  try {
    const config = resolveLlm({
      GEMINI_API_KEY: 'k',
      GEMINI_BASE_URL: mock.base,
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
    });
    assert.equal(config.configured, true);

    const text = await callGemini(
      { system: 's', user: 'u' },
      { ...config, endpoint: `${mock.base}/interactions` },
    );

    assert.equal(text, REPLY);
    // The throttled model was tried, and then a different one succeeded. This is the
    // exact case that used to yield no narrative at all.
    assert.ok(mock.seen.some((c) => c.model === 'gemini-3.1-flash-lite'), 'the requested model should be tried first');
    assert.ok(
      mock.seen.some((c) => c.model !== 'gemini-3.1-flash-lite'),
      'a different model should have been tried after the limit',
    );
  } finally {
    await mock.close();
  }
});

test('a daily rate limit is reported, not waited through', async () => {
  // Every model throttled with an 8-hour retry-after. Sitting on that would hold the
  // request open far past any timeout, so the error has to name the limit instead.
  const mock = await geminiMock({
    throttled: ['gemini-3.1-flash-lite', ...GEMINI_FALLBACKS],
  });
  try {
    const config = resolveLlm({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: mock.base });
    await assert.rejects(
      () => callGemini({ system: 's', user: 'u' }, { ...config, endpoint: `${mock.base}/interactions` }),
      (err) => {
        assert.match(err.message, /rate limited/i);
        // Asserted against LIMITS rather than a literal, because the free tier numbers
        // are Google's to change and the copy here follows them.
        assert.ok(err.message.includes(LIMITS.gemini), 'the free tier guidance should be quoted');
        assert.match(err.message, /8h/, 'the reset time should be reported');
        return true;
      },
    );
    // One call per model, not four body attempts per model: retrying an exhausted
    // quota just spends it faster. The default model is itself a fallback, so the
    // count is the deduplicated list.
    const distinct = new Set([config.model, ...GEMINI_FALLBACKS]);
    assert.equal(mock.seen.length, distinct.size);
  } finally {
    await mock.close();
  }
});

test('a mistyped model is named back, listing the ones that exist', async () => {
  const mock = await geminiMock({ gone: ['gemini-3.8-flsh', ...GEMINI_FALLBACKS] });
  try {
    const config = resolveLlm({
      GEMINI_API_KEY: 'k',
      GEMINI_BASE_URL: mock.base,
      GEMINI_MODEL: 'gemini-3.8-flsh',
    });
    await assert.rejects(
      () => callGemini({ system: 's', user: 'u' }, { ...config, endpoint: `${mock.base}/interactions` }),
      (err) => {
        // The caller's own typo is reported, not the last fallback that was tried.
        assert.match(err.message, /gemini-3\.8-flsh/);
        for (const known of Object.keys(GEMINI_MODELS)) {
          assert.ok(err.message.includes(known), `${known} should be listed as a known model`);
        }
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

/* ── The two ladders stay distinct ────────────────────────────────────────── */

test('a refused field is retried with a smaller body, not with backoff', async () => {
  const mock = await openAiMock();
  try {
    const config = resolveLlm({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: mock.base,
      LLM_MODEL: 'some-model',
    });
    const text = await callOpenAiCompatible({ system: 's', user: 'u' }, config);

    assert.equal(text, REPLY);
    assert.equal(mock.seen.length, 2, 'one refusal, then one smaller body');
    assert.equal(mock.seen[0].response_format.type, 'json_object');
    assert.equal(mock.seen[1].response_format, undefined, 'the refused field must be gone');
  } finally {
    await mock.close();
  }
});

test('a 429 is retried identically rather than by shedding fields', async () => {
  // The bug this fixes: a rate limit used to walk the body ladder, spending four
  // requests from an already-exhausted quota and still failing.
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls += 1;
      if (calls <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { port } = server.address();
    const config = resolveLlm({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_MODEL: 'm',
    });
    const text = await callOpenAiCompatible({ system: 's', user: 'u' }, config);

    assert.equal(text, REPLY);
    // Same body three times: a 429 is not fixed by sending less.
    assert.equal(calls, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('an unknown model ends the call instead of shrinking the request four times', async () => {
  // NVIDIA answers an unknown model id with a bare `404 page not found`. Shedding
  // fields cannot produce a model that does not exist, so this must terminate on the
  // first response rather than spend four calls reaching the same conclusion.
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 page not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { port } = server.address();
    const config = resolveLlm({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_MODEL: 'nvidia/does-not-exist',
    });
    await assert.rejects(
      () => callOpenAiCompatible({ system: 's', user: 'u' }, config),
      (err) => {
        assert.match(err.message, /no such model/i);
        // The message must not depend on the body, which here is not JSON.
        assert.doesNotMatch(err.message, /page not found\n/);
        return true;
      },
    );
    assert.equal(calls, 1, 'a 404 is terminal');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a rejected key ends the call on the first response', async () => {
  // 401 and 403 mean the key itself was refused; a smaller body is still a refused
  // key, so retrying would spend quota on a per-day tier to learn nothing.
  for (const status of [401, 403]) {
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authorization failed' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));

    try {
      const { port } = server.address();
      const config = resolveLlm({
        LLM_API_KEY: 'k',
        LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        LLM_MODEL: 'm',
      });
      await assert.rejects(
        () => callOpenAiCompatible({ system: 's', user: 'u' }, config),
        (err) => {
          assert.match(err.message, /rejected that key/i);
          return true;
        },
      );
      assert.equal(calls, 1, `a ${status} is terminal`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

test('the token budget leaves room for a reasoning model to think', async () => {
  // A reasoning model spends part of its budget before answering, and those tokens
  // come out of max_tokens. NVIDIA's own sample for a Nemotron reasoning model asks
  // for 65536. A cap sized for a chat reply truncates the JSON mid-object, and the
  // sanitiser then discards the whole narrative with no way to tell it apart from a
  // bad answer.
  let seen = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: REPLY } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { port } = server.address();
    const config = resolveLlm({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_MODEL: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    });
    await callOpenAiCompatible({ system: 's', user: 'u' }, config);
    assert.ok(seen.max_tokens >= 8_000, `max_tokens was ${seen.max_tokens}, too small to survive reasoning`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('an hourly rate limit is reported rather than sat on', async () => {
  const server = createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '3600' });
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { port } = server.address();
    const config = resolveLlm({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_MODEL: 'm',
    });
    const started = Date.now();
    await assert.rejects(
      () => callOpenAiCompatible({ system: 's', user: 'u' }, config),
      (err) => {
        assert.match(err.message, /rate limited/i);
        assert.match(err.message, /1h/);
        return true;
      },
    );
    // Three attempts, none of them waiting an hour.
    assert.ok(Date.now() - started < 5_000, 'must not wait out an hourly limit');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ── Presets, end to end through narrate ──────────────────────────────────── */

test('narrate returns a narrative from a preset with only a key', async () => {
  const mock = await openAiMock({ rejectFirst: false });
  try {
    const result = await narrate(FACTS, {
      pages: 8,
      creds: { LLM_PRESET: 'custom', LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
    });
    assert.equal(result.meta.used, true);
    assert.equal(result.narrative.pillars.length, 1);
    assert.equal(result.narrative.pillars[0].verified, true);
  } finally {
    await mock.close();
  }
});

test('every OpenAI-compatible preset points at https and has a live-looking model', () => {
  for (const preset of PRESETS) {
    if (preset.transport === 'gemini') continue;
    if (preset.id === 'custom') continue;

    assert.ok(preset.baseUrl?.startsWith('https://'), `${preset.id} needs an https base URL`);
    assert.ok(preset.models?.length > 0, `${preset.id} needs at least one model`);
    for (const model of preset.models) {
      assert.ok(model.id?.length, `${preset.id} has a model with no id`);
      assert.equal(model.id.includes(' '), false, `${preset.id} model ids must not contain spaces`);
    }
  }
});

test('the presets are ordered free tier first, and say which are free', () => {
  // The panel's order is an argument, not decoration: a visitor without a payment
  // method can only use the free ones, so none of them may sit below a paid one.
  const listed = PRESETS.filter((p) => p.id !== 'custom');
  const firstPaid = listed.findIndex((p) => !p.free);

  if (firstPaid !== -1) {
    // Everything above the first paid entry must be free; everything below must not be.
    for (const preset of listed.slice(0, firstPaid)) {
      assert.equal(preset.free, true, `${preset.id} is listed above the paid presets but is not free`);
    }
    for (const preset of listed.slice(firstPaid)) {
      assert.equal(preset.free, false, `${preset.id} is free but is listed below a paid preset`);
    }
  }

  // Every free preset needs somewhere to send someone for a key.
  for (const preset of PRESETS) {
    if (!preset.free) continue;
    assert.ok(preset.keyUrl?.startsWith('https://'), `${preset.id} is free but has no key URL`);
  }
});

test('the Gemini default is a model that is actually available', () => {
  // The default has to exist in the table, or the settings panel cannot show it.
  assert.ok(Object.keys(GEMINI_MODELS).includes('gemini-3.1-flash-lite'));
  // And it must not be the flagship, which is the one that was at capacity.
  assert.notEqual('gemini-3.1-flash-lite', 'gemini-3.8-flash');
});

test('the panel and the server agree on every preset', async () => {
  // The Settings panel carries its own copy of the catalogue so the dialog can render
  // before any request is made, and `GET /api/v1` serves the server's. Two copies
  // drift, and the drift is invisible until someone picks a model that does not work.
  const { PROVIDERS } = await import('../public/creds.js');

  // The panel adds one entry the server catalogue has no reason to list: "none —
// measured pages only". It is a choice about narration, not a provider.
  const serverIds = PRESETS.map((p) => p.id).sort();
  const panelIds = PROVIDERS.map((p) => p.value).filter(Boolean).sort();
  assert.deepEqual(panelIds, serverIds, 'the provider lists differ');
  assert.equal(PROVIDERS[0].value, '', '"none" must stay first, so it is the default');

  const panelGemini = PROVIDERS.find((p) => p.value === 'gemini');
  const { GEMINI_MODELS } = await import('../src/pipeline/llm-presets.js');

  for (const preset of PRESETS) {
    const panel = PROVIDERS.find((p) => p.value === preset.id);
    assert.equal(panel.free, preset.free, `${preset.id}: free flag differs`);

    if (preset.id === 'custom') continue;

    if (preset.transport === 'gemini') {
      // Gemini's table lives in GEMINI_MODELS on both sides rather than in the
      // preset's own `models`, so compare against that.
      for (const model of panelGemini.models) {
        assert.ok(GEMINI_MODELS[model.id], `${model.id} is in the panel but not in GEMINI_MODELS`);
      }
      continue;
    }

    assert.equal(panel.baseUrl, preset.baseUrl, `${preset.id}: base URL differs`);

    const panelModels = panel.models.map((m) => m.id).sort();
    const serverModels = preset.models.map((m) => m.id).sort();
    assert.deepEqual(panelModels, serverModels, `${preset.id}: model lists differ`);
  }
});

test('every Gemini fallback is a real entry in the model table', () => {
  for (const model of GEMINI_FALLBACKS) {
    assert.ok(Object.keys(GEMINI_MODELS).includes(model), `${model} is a fallback but not in the table`);
  }
});

test('the fallbacks do not repeat the requested model', async () => {
  const mock = await geminiMock({ throttled: ['gemini-3.1-flash-lite'] });
  try {
    const config = resolveLlm({
      GEMINI_API_KEY: 'k',
      GEMINI_BASE_URL: mock.base,
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
    });
    await callGemini({ system: 's', user: 'u' }, { ...config, endpoint: `${mock.base}/interactions` });

    const tried = mock.seen.map((c) => c.model);
    assert.equal(new Set(tried).size, tried.length, `a model was tried twice: ${tried.join(', ')}`);
  } finally {
    await mock.close();
  }
});