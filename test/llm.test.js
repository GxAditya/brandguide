/**
 * LLM narration layer.
 *
 * Runs against mock providers rather than real ones, so it verifies the things a
 * user actually depends on when they drop a key in:
 *
 *   1. With no LLM configured, nothing breaks and nothing is called.
 *   2. With an LLM configured, the call *degrades* rather than fails when the
 *      provider rejects an optional field.
 *   3. The provider is chosen from `.env`, and the model named there is the model
 *      that gets called.
 *
 * `response_format` is an OpenAI extension many compatible servers do not
 * implement, and `max_tokens` was renamed for OpenAI's reasoning models. A user
 * should not have to hunt for a provider that accepts both — and Gemini does not
 * serve `/chat/completions` on its own domain at all, so it gets its own
 * transport and its own mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { llmConfigured, llmInfo, narrate } from '../src/pipeline/llm.js';
import { resolveLlm, GEMINI_DEFAULT_MODEL } from '../src/pipeline/llm-provider.js';

/**
 * A mock provider. `reject` is a predicate over the request body; when it
 * matches, the server answers 400 the way a strict real server would.
 */
function startMock({ reject = () => false, reply = null } = {}) {
  const received = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push({ headers: req.headers, body });

      if (req.method === 'POST' && req.url === '/v1/chat/completions' && !reject(body)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: reply || JSON.stringify({
            toneSummary: 'Measured from the copy.',
            positioning: 'A positioning line.',
            pillars: [{ name: 'Speed', claim: 'Ships faster.', evidence: 'Align your team with clear PRDs.' }],
            doNext: ['Keep sentences short'],
            watchOuts: ['No jargon'],
          }) } }],
        }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unsupported parameter' } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        received,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const FACTS = {
  identity: { name: 'Acme', domain: 'acme.test' },
  voice: {
    vector: { directness: 0.8, formality: 0.2 },
    raw: { avgSentenceLength: 14 },
    descriptors: [{ axis: 'Register', value: 'casual', note: 'writes the way it talks' }],
    signalSentences: [{ text: 'Align your team with clear PRDs.' }],
  },
  messaging: {
    headlines: [{ text: 'Ship faster' }],
    claims: [],
    positioning: { text: 'A positioning line.' },
    keywords: [],
  },
  colors: { tokens: [] },
  typography: { families: [] },
};

/**
 * Every variable that can turn the narration layer on.
 *
 * All of them are cleared before each test, not just the `LLM_*` trio. A
 * developer who has `GEMINI_API_KEY` exported in their shell would otherwise
 * have every OpenAI-compatible test below silently switch providers, and the
 * failure would look like a bug in the code rather than in the test.
 */
const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'GEMINI_THINKING_LEVEL',
  'GOOGLE_API_KEY',
];

function swapEnv(vars) {
  const saved = {};
  for (const key of LLM_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  return () => {
    for (const key of LLM_ENV_KEYS) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  };
}

/**
 * Run `fn` with the narration environment replaced, then put it back.
 *
 * `fn` may be sync or async. When it hands back a promise the environment is held
 * until that promise settles, which is the whole difficulty: a `finally` that
 * runs the moment `fn()` returns its promise restores too early, and every test
 * that awaits inside `fn` then calls `narrate()` with no key configured and
 * passes or fails for entirely the wrong reason.
 */
function withEnv(vars, fn) {
  const restore = swapEnv(vars);
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.then(
    (value) => { restore(); return value; },
    (err) => { restore(); throw err; },
  );
  restore();
  return result;
}

/** The same helper, named for the call sites that await it. */
function withEnvAsync(vars, fn) {
  return withEnv(vars, fn);
}

test('with no LLM configured, the layer is inert', async () => {
  await withEnv({}, async () => {
    assert.equal(llmConfigured(), false);
    const info = llmInfo();
    assert.equal(info.enabled, false);
    assert.match(info.note, /No LLM configured/);

    const result = await narrate(FACTS);
    assert.equal(result.narrative, null);
    assert.equal(result.meta.used, false);
    assert.match(result.meta.reason, /no LLM configured/);
  });
});

test('a partially configured LLM is treated as not configured', async () => {
  await withEnv({ LLM_API_KEY: 'k' }, () => {
    assert.equal(llmConfigured(), false, 'all three variables are required together');
  });
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1' }, () => {
    assert.equal(llmConfigured(), false);
  });
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' }, () => {
    assert.equal(llmConfigured(), true);
  });
});

test('a full provider is called once and its narrative is sanitised', async () => {
  const mock = await startMock();
  try {
    await withEnv(
      { LLM_API_KEY: 'test-key', LLM_BASE_URL: mock.base, LLM_MODEL: 'test-model' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.meta.used, true);
        assert.equal(result.meta.model, 'test-model');
        assert.equal(mock.received.length, 1);
        assert.equal(mock.received[0].body.response_format.type, 'json_object');
        assert.equal(mock.received[0].headers.authorization, 'Bearer test-key');
        assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
      },
    );
  } finally {
    await mock.close();
  }
});

test('a provider that rejects response_format still works', async () => {
  const mock = await startMock({ reject: (b) => 'response_format' in b });
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.meta.used, true, 'the call must degrade, not fail');
        assert.equal(mock.received.length, 2, 'one rejected attempt, one accepted');
        assert.ok(!('response_format' in mock.received[1].body));
        assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
      },
    );
  } finally {
    await mock.close();
  }
});

test('a provider that rejects both max_tokens spellings still works', async () => {
  const mock = await startMock({
    reject: (b) => 'response_format' in b || 'max_tokens' in b,
  });
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.meta.used, true);
        assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
      },
    );
  } finally {
    await mock.close();
  }
});

test('a provider that rejects everything fails cleanly rather than throwing', async () => {
  const mock = await startMock({ reject: () => true });
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.narrative, null);
        assert.equal(result.meta.used, false);
        assert.match(result.meta.reason, /HTTP 400/);
        assert.equal(mock.received.length, 4, 'tries every body shape, then stops');
      },
    );
  } finally {
    await mock.close();
  }
});

test('an unreachable provider fails cleanly rather than throwing', async () => {
  await withEnv(
    // Port 1 is reserved, so the connection is refused immediately.
    { LLM_API_KEY: 'k', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_MODEL: 'm' },
    async () => {
      const result = await narrate(FACTS);
      assert.equal(result.narrative, null);
      assert.equal(result.meta.used, false);
      assert.match(result.meta.reason, /LLM call failed/);
    },
  );
});

test('a provider returning non-JSON does not corrupt the guide', async () => {
  const mock = await startMock({ reply: 'Sure! Here is your brand guide in prose form.' });
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.narrative, null, 'unparseable output is dropped, not half-applied');
        assert.match(result.meta.reason, /parseable JSON/);
      },
    );
  } finally {
    await mock.close();
  }
});

test('a pillar whose evidence is invented is dropped, not passed through', async () => {
  const mock = await startMock({
    reply: JSON.stringify({
      toneSummary: 'Fine.',
      pillars: [
        { name: 'Real', claim: 'Uses clear PRDs.', evidence: 'Align your team with clear PRDs.' },
        { name: 'Invented', claim: 'Saves 40 hours a week.', evidence: 'Teams save 40 hours a week.' },
      ],
    }),
  });
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS);
        const real = result.narrative.pillars.find((p) => p.name === 'Real');
        const invented = result.narrative.pillars.find((p) => p.name === 'Invented');

        assert.equal(real.verified, true);
        assert.equal(invented.verified, false, 'an unquoted claim is not evidence');
        assert.equal(invented.evidence, null, 'and the invented quote is removed');
      },
    );
  } finally {
    await mock.close();
  }
});

test('the requested page length reaches the model as a pillar count', async () => {
  // The user picks a length in the UI. If the budget never reached the prompt,
  // every guide would come back the same size no matter what was asked for.
  const mock = await startMock();
  const promptFor = (pages) => {
    const system = mock.received.at(-1).body.messages[0].content;
    return /asked for a (\d+)-page brand guide\. Return exactly (\d+) pillars/.exec(system);
  };

  try {
    await withEnvAsync(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        await narrate(FACTS, { pages: 8 });
        const short = promptFor(8);
        assert.ok(short, 'the prompt must state the requested length');
        assert.equal(Number(short[1]), 8);

        await narrate(FACTS, { pages: 22 });
        const long = promptFor(22);
        assert.equal(Number(long[1]), 22);
        assert.ok(
          Number(long[2]) > Number(short[2]),
          'a longer guide should ask for more pillars, not the same amount',
        );

        // Out-of-range input is clamped before it ever reaches the model.
        await narrate(FACTS, { pages: 9999 });
        assert.equal(Number(promptFor(0)[1]), 24);
      },
    );
  } finally {
    await mock.close();
  }
});

test('the budget is reported back so the deck can explain a shortfall', async () => {
  const mock = await startMock();
  try {
    await withEnv(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const result = await narrate(FACTS, { pages: 18 });
        assert.equal(result.meta.used, true);
        assert.equal(result.meta.pagesRequested, 18);
      },
    );
  } finally {
    await mock.close();
  }
});

test('a short budget truncates the pillars the model returns', async () => {
  // The model is told how many to write, but it can still over-deliver. The
  // sanitiser is the last place that gets enforced.
  const pillars = Array.from({ length: 5 }, (_, i) => ({
    name: `Pillar ${i + 1}`,
    claim: 'Uses clear PRDs.',
    evidence: 'Align your team with clear PRDs.',
  }));
  const mock = await startMock({
    reply: JSON.stringify({ toneSummary: 'Fine.', pillars }),
  });

  try {
    await withEnvAsync(
      { LLM_API_KEY: 'k', LLM_BASE_URL: mock.base, LLM_MODEL: 'm' },
      async () => {
        const short = await narrate(FACTS, { pages: 6 });
        assert.equal(short.narrative.pillars.length, 3, 'a six-page guide takes three pillars');

        const long = await narrate(FACTS, { pages: 22 });
        assert.equal(long.narrative.pillars.length, 5);
      },
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** The narrative every Gemini mock returns unless told otherwise. */
const GEMINI_REPLY = JSON.stringify({
  toneSummary: 'Measured from the copy.',
  positioning: 'A positioning line.',
  pillars: [{ name: 'Speed', claim: 'Ships faster.', evidence: 'Align your team with clear PRDs.' }],
  doNext: ['Keep sentences short'],
  watchOuts: ['No jargon'],
});

/**
 * A mock Gemini, speaking the Interactions API.
 *
 * Gemini does not serve `/chat/completions`, so this stands up a different route,
 * a different auth header and a different response envelope. If it accidentally
 * reused the OpenAI mock, every Gemini test would pass without exercising the
 * transport at all.
 *
 * `reject` refuses individual requests, answering 400 the way a strict server
 * would. `failStatus` refuses everything with a specific code, which is how a
 * test asks for one particular failure — 404 for an unknown model id, say.
 */
function startGeminiMock({ reject = () => false, reply = null, failStatus = null } = {}) {
  const received = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method === 'POST' && req.url === '/v1beta/interactions' && !failStatus && !reject(body)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'interaction',
          model: body.model,
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: reply ?? GEMINI_REPLY }],
            },
          ],
        }));
        return;
      }

      res.writeHead(failStatus || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: failStatus || 400,
          message: failStatus === 404
            ? `models/${body.model} is not found for API version v1beta.`
            : 'Unsupported field in request payload.',
          status: 'INVALID_ARGUMENT',
        },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1beta`,
        received,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A Gemini key pointed at a mock, plus whatever else the test wants to set. */
const geminiEnv = (mock, extra = {}) => ({
  GEMINI_API_KEY: 'test-key',
  GEMINI_BASE_URL: mock.base,
  ...extra,
});

test('a Gemini key alone is enough, and defaults to the current flagship model', async () => {
  const mock = await startGeminiMock();
  try {
    await withEnv(
      { GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: mock.base },
      async () => {
        const info = llmInfo();
        assert.equal(info.enabled, true);
        assert.equal(info.provider, 'gemini');
        assert.equal(info.model, GEMINI_DEFAULT_MODEL, 'a key with no model still works');

        const result = await narrate(FACTS);
        assert.equal(result.meta.used, true);
        assert.equal(result.meta.provider, 'gemini');
        assert.equal(result.meta.model, GEMINI_DEFAULT_MODEL);
        assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
        assert.equal(result.narrative.pillars[0].verified, true);
      },
    );
  } finally {
    await mock.close();
  }
});

test('GEMINI_MODEL in .env selects the model that gets called', async () => {
  // The whole point of the layer being env-driven: switching models must not mean
  // editing source. The id has to reach the wire, not just the status output.
  const mock = await startGeminiMock();
  try {
    await withEnv(
      geminiEnv(mock, { GEMINI_MODEL: 'gemini-3.5-flash-lite' }),
      async () => {
        assert.equal(llmInfo().model, 'gemini-3.5-flash-lite');

        const result = await narrate(FACTS);
        assert.equal(result.meta.model, 'gemini-3.5-flash-lite');
        assert.equal(mock.received[0].body.model, 'gemini-3.5-flash-lite');
      },
    );
  } finally {
    await mock.close();
  }
});

test('GOOGLE_API_KEY is accepted, because Google uses both spellings', async () => {
  const mock = await startGeminiMock();
  try {
    await withEnv(
      { GOOGLE_API_KEY: 'test-key', GEMINI_BASE_URL: mock.base, GEMINI_MODEL: 'gemini-3.8-flash' },
      async () => {
        const result = await narrate(FACTS);
        assert.equal(result.meta.used, true);
        assert.equal(result.meta.provider, 'gemini');
        assert.equal(mock.received[0].headers['x-goog-api-key'], 'test-key');
      },
    );
  } finally {
    await mock.close();
  }
});

test('Gemini is called on its own endpoint with its own auth header', async () => {
  // A bearer token against /chat/completions is the OpenAI shape. Getting this
  // wrong produces a 404 that reads like a bad model id, so it is worth pinning.
  const mock = await startGeminiMock();
  try {
    await withEnv(geminiEnv(mock), async () => {
      await narrate(FACTS);

      assert.equal(mock.received.length, 1);
      assert.equal(mock.received[0].url, '/v1beta/interactions');
      assert.equal(mock.received[0].headers['x-goog-api-key'], 'test-key');
      assert.equal(mock.received[0].headers.authorization, undefined);
      assert.equal(typeof mock.received[0].body.input, 'string');
      assert.equal(typeof mock.received[0].body.system_instruction, 'string');
    });
  } finally {
    await mock.close();
  }
});

test('Gemini is asked for JSON by schema, not merely by prompt', async () => {
  const mock = await startGeminiMock();
  try {
    await withEnv(geminiEnv(mock), async () => {
      await narrate(FACTS);
      const { response_format: format } = mock.received[0].body;
      assert.equal(format.mime_type, 'application/json');
      assert.ok(format.schema, 'a schema makes the shape a guarantee, not a request');
      assert.ok(format.schema.properties.toneSummary);
      assert.ok(format.schema.properties.pillars);
    });
  } finally {
    await mock.close();
  }
});

test('thinking is turned down by default and can be raised from .env', async () => {
  // Gemini 3 reasons before answering and those tokens come out of the same output
  // budget, so an explicit low level is what keeps narration cheap and uncut.
  const mock = await startGeminiMock();
  try {
    await withEnvAsync(geminiEnv(mock), async () => {
      await narrate(FACTS);
      assert.equal(mock.received.at(-1).body.generation_config.thinking_level, 'low');
      assert.equal(llmInfo().thinkingLevel, 'low');
    });

    await withEnvAsync(geminiEnv(mock, { GEMINI_THINKING_LEVEL: 'high' }), async () => {
      await narrate(FACTS);
      assert.equal(mock.received.at(-1).body.generation_config.thinking_level, 'high');
    });
  } finally {
    await mock.close();
  }
});

test('a Gemini endpoint that rejects the structured-output field still works', async () => {
  const mock = await startGeminiMock({ reject: (b) => 'response_format' in b });
  try {
    await withEnv(geminiEnv(mock), async () => {
      const result = await narrate(FACTS);
      assert.equal(result.meta.used, true, 'the call must degrade, not fail');
      assert.equal(mock.received.length, 2, 'one rejected attempt, one accepted');
      assert.ok(!('response_format' in mock.received[1].body));
      assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
    });
  } finally {
    await mock.close();
  }
});

test('a Gemini endpoint that rejects every optional field still works', async () => {
  const mock = await startGeminiMock({
    reject: (b) => 'response_format' in b || 'generation_config' in b,
  });
  try {
    await withEnv(geminiEnv(mock), async () => {
      const result = await narrate(FACTS);
      assert.equal(result.meta.used, true);
      assert.equal(mock.received.length, 4, 'drops the schema, then the thinking level');
      const last = mock.received.at(-1).body;
      assert.deepEqual(Object.keys(last).sort(), ['input', 'model', 'system_instruction']);
      assert.equal(result.narrative.toneSummary, 'Measured from the copy.');
    });
  } finally {
    await mock.close();
  }
});

test('an unknown Gemini model id names the models that do exist', async () => {
  // A mistyped id is the most common Gemini mistake and a bare 404 does not tell
  // you which string was wrong, so the reason has to.
  const mock = await startGeminiMock({ failStatus: 404 });
  try {
    await withEnv(geminiEnv(mock, { GEMINI_MODEL: 'gemini-3.8-flsh' }), async () => {
      const result = await narrate(FACTS);
      assert.equal(result.narrative, null);
      assert.equal(result.meta.used, false);
      assert.match(result.meta.reason, /HTTP 404/);
      assert.match(result.meta.reason, /gemini-3\.8-flash/);
    });
  } finally {
    await mock.close();
  }
});

test('a Gemini reply with no text steps is dropped rather than half-applied', async () => {
  const mock = await startGeminiMock({ reply: '' });
  try {
    await withEnv(geminiEnv(mock), async () => {
      const result = await narrate(FACTS);
      assert.equal(result.narrative, null);
      assert.match(result.meta.reason, /parseable JSON/);
    });
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

test('LLM_PROVIDER=gemini without a key explains itself instead of staying quiet', async () => {
  await withEnv({ LLM_PROVIDER: 'gemini' }, () => {
    assert.equal(llmConfigured(), false);

    const info = llmInfo();
    assert.equal(info.enabled, false);
    assert.equal(info.provider, 'gemini');
    assert.match(info.problem, /GEMINI_API_KEY/);
    assert.match(info.problem, /aistudio\.google\.com/);
  });
});

test('an unrecognised LLM_PROVIDER is an error naming the two valid values', async () => {
  // Silently falling back would produce a guide that never gets narrated and a
  // config file that looks correct.
  await withEnv({ LLM_PROVIDER: 'anthropic' }, async () => {
    const info = llmInfo();
    assert.equal(info.enabled, false);
    assert.match(info.problem, /LLM_PROVIDER/);
    assert.match(info.problem, /gemini/);
    assert.match(info.problem, /openai/);

    const result = await narrate(FACTS);
    assert.equal(result.narrative, null);
    assert.match(result.meta.reason, /LLM_PROVIDER/);
  });
});

test('a complete LLM_ trio outranks a leftover Gemini key', async () => {
  // Three agreeing variables are a deliberate configuration; a single key may
  // just be left over from something else. LLM_PROVIDER settles it either way.
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', GEMINI_API_KEY: 'g' }, () => {
    assert.equal(llmInfo().provider, 'openai-compatible');
  });

  await withEnv(
    { LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', GEMINI_API_KEY: 'g', LLM_PROVIDER: 'gemini' },
    () => {
      assert.equal(llmInfo().provider, 'gemini');
    },
  );
});

test('LLM_MODEL names the model even on Gemini', async () => {
  const mock = await startGeminiMock();
  try {
    await withEnv(
      { GEMINI_API_KEY: 'k', GEMINI_BASE_URL: mock.base, LLM_MODEL: 'gemini-3.7-flash' },
      async () => {
        await narrate(FACTS);
        assert.equal(mock.received[0].body.model, 'gemini-3.7-flash');
      },
    );
  } finally {
    await mock.close();
  }
});

test('an incomplete OpenAI-compatible trio does not half-enable the layer', async () => {
  await withEnv({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' }, () => {
    const info = llmInfo();
    assert.equal(info.enabled, false);
    assert.match(info.problem, /LLM_BASE_URL/);
    assert.match(info.problem, /LLM_MODEL/);
  });
});

test('provider resolution is a pure function of the environment', async () => {
  // resolveLlm takes its env as an argument precisely so this is checkable
  // without mutating process.env, which matters because every other test here
  // depends on process.env being predictable.
  assert.equal(resolveLlm({}).configured, false);
  assert.equal(resolveLlm({ GEMINI_API_KEY: 'k' }).provider, 'gemini');
  assert.equal(resolveLlm({ GEMINI_API_KEY: 'k' }).model, GEMINI_DEFAULT_MODEL);
  assert.equal(resolveLlm({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1/', LLM_MODEL: 'm' }).endpoint, 'http://x/v1/chat/completions');
  assert.equal(resolveLlm({ LLM_PROVIDER: 'nope' }).configured, false);
  assert.equal(resolveLlm({ GEMINI_BASE_URL: 'http://x/v1beta/' }).endpoint, undefined, 'no key means no endpoint');
});