/**
 * LLM narration layer.
 *
 * Runs against mock providers rather than real ones, so it verifies the things a
 * user actually depends on when they drop a key in:
 *
 *   1. With no LLM key for the request, nothing breaks and nothing is called.
 *   2. With a key, the call *degrades* rather than fails when the provider rejects
 *      an optional field.
 *   3. The provider is chosen from the credentials passed in, and the model named
 *      there is the model that gets called.
 *   4. Two callers in one process resolve independently, which the old
 *      environment-variable model could not express.
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
/**
 * Run `fn` with one caller's credentials, and hand those credentials to it.
 *
 * Credentials are passed in rather than read from `process.env`, so these tests
 * describe the same contract the server uses: one object, in, per request. It also
 * removes the reason this helper existed at all. Swapping the environment needed
 * save-and-restore around a callback that might return a promise, and the subtle
 * part was holding the swap until that promise settled — an early restore made
 * every test that awaited inside `fn` call `narrate()` with no key and pass for
 * entirely the wrong reason. There is no state here to leak into a later test.
 *
 * `fn` may be sync or async; the return value is passed straight through.
 */
function withEnv(vars, fn) {
  return fn({ ...vars });
}

/** The same helper, named for the call sites that await it. */
function withEnvAsync(vars, fn) {
  return withEnv(vars, fn);
}

test('with no LLM key for the request, the layer is inert', async () => {
  await withEnv({}, async (creds) => {
    assert.equal(llmConfigured(creds), false);
    const info = llmInfo(creds);
    assert.equal(info.enabled, false);
    assert.match(info.note, /No LLM key/);

    const result = await narrate(FACTS, { creds });
    assert.equal(result.narrative, null);
    assert.equal(result.meta.used, false);
    assert.match(result.meta.reason, /no LLM key supplied for this request/);
  });
});

/**
 * The layer is per request, so two extractions in the same process can carry two
 * different keys. Under the old environment-variable model this was impossible to
 * express: the second call would silently reuse the first caller's key.
 */
test('one process resolves two callers independently', async () => {
  const gemini = await startGeminiMock();
  const openAi = await startMock();
  try {
    const withGemini = { GEMINI_API_KEY: 'gemini-key', GEMINI_BASE_URL: gemini.base };
    const withOpenAi = {
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'openai-key',
      LLM_BASE_URL: openAi.base,
      LLM_MODEL: 'test-model',
    };

    assert.equal(llmInfo(withGemini).provider, 'gemini');
    assert.equal(llmInfo(withOpenAi).provider, 'openai-compatible');

    // Run one to completion, then the other. The second must not inherit the
    // first's provider, and the first must not have leaked into the second's key.
    await narrate(FACTS, { creds: withGemini });
    assert.equal(gemini.received.length, 1);
    assert.equal(openAi.received.length, 0);

    await narrate(FACTS, { creds: withOpenAi });
    assert.equal(gemini.received.length, 1, 'the Gemini key must not fire a second time');
    assert.equal(openAi.received.length, 1);
  } finally {
    await gemini.close();
    await openAi.close();
  }
});

test('a partially configured LLM is treated as not configured', async () => {
  await withEnv({ LLM_API_KEY: 'k' }, async (creds) => {
    assert.equal(llmConfigured(creds), false, 'all three variables are required together');
  });
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1' }, async (creds) => {
    assert.equal(llmConfigured(creds), false);
  });
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' }, async (creds) => {
    assert.equal(llmConfigured(creds), true);
  });
});

test('a full provider is called once and its narrative is sanitised', async () => {
  const mock = await startMock();
  try {
    await withEnv(
      { LLM_API_KEY: 'test-key', LLM_BASE_URL: mock.base, LLM_MODEL: 'test-model' },
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
        assert.equal(result.narrative, null);
        assert.equal(result.meta.used, false);
        assert.match(result.meta.reason, /HTTP 400/);
        // Every rung of the ladder, then stop. The count is the ladder's length, which
        // is asserted here so a rung cannot be added or removed without this moving.
        assert.equal(mock.received.length, 6, 'tries every body shape, then stops');
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
    async (creds) => {
      const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        await narrate(FACTS, { pages: 8, creds });
        const short = promptFor(8);
        assert.ok(short, 'the prompt must state the requested length');
        assert.equal(Number(short[1]), 8);

        await narrate(FACTS, { pages: 22, creds });
        const long = promptFor(22);
        assert.equal(Number(long[1]), 22);
        assert.ok(
          Number(long[2]) > Number(short[2]),
          'a longer guide should ask for more pillars, not the same amount',
        );

        // Out-of-range input is clamped before it ever reaches the model.
        await narrate(FACTS, { pages: 9999, creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { pages: 18, creds });
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
      async (creds) => {
        const short = await narrate(FACTS, { pages: 6, creds });
        assert.equal(short.narrative.pillars.length, 3, 'a six-page guide takes three pillars');

        const long = await narrate(FACTS, { pages: 22, creds });
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
      async (creds) => {
        const info = llmInfo(creds);
        assert.equal(info.enabled, true);
        assert.equal(info.provider, 'gemini');
        assert.equal(info.model, GEMINI_DEFAULT_MODEL, 'a key with no model still works');

        const result = await narrate(FACTS, { creds });
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

test('the named Gemini model is the model that gets called', async () => {
  // Switching models must not mean editing source. The id has to reach the wire,
  // not just the status output.
  const mock = await startGeminiMock();
  try {
    await withEnv(
      geminiEnv(mock, { GEMINI_MODEL: 'gemini-3.5-flash-lite' }),
      async (creds) => {
        assert.equal(llmInfo(creds).model, 'gemini-3.5-flash-lite');

        const result = await narrate(FACTS, { creds });
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
      async (creds) => {
        const result = await narrate(FACTS, { creds });
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
    await withEnv(geminiEnv(mock), async (creds) => {
      await narrate(FACTS, { creds });

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
    await withEnv(geminiEnv(mock), async (creds) => {
      await narrate(FACTS, { creds });
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

test('thinking is turned down by default and can be raised by the caller', async () => {
  // Gemini 3 reasons before answering and those tokens come out of the same output
  // budget, so an explicit low level is what keeps narration cheap and uncut.
  const mock = await startGeminiMock();
  try {
    await withEnvAsync(geminiEnv(mock), async (creds) => {
      await narrate(FACTS, { creds });
      assert.equal(mock.received.at(-1).body.generation_config.thinking_level, 'low');
      assert.equal(llmInfo(creds).thinkingLevel, 'low');
    });

    await withEnvAsync(geminiEnv(mock, { GEMINI_THINKING_LEVEL: 'high' }), async (creds) => {
      await narrate(FACTS, { creds });
      assert.equal(mock.received.at(-1).body.generation_config.thinking_level, 'high');
    });
  } finally {
    await mock.close();
  }
});

test('a Gemini endpoint that rejects the structured-output field still works', async () => {
  const mock = await startGeminiMock({ reject: (b) => 'response_format' in b });
  try {
    await withEnv(geminiEnv(mock), async (creds) => {
      const result = await narrate(FACTS, { creds });
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
    await withEnv(geminiEnv(mock), async (creds) => {
      const result = await narrate(FACTS, { creds });
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
    await withEnv(geminiEnv(mock, { GEMINI_MODEL: 'gemini-3.8-flsh' }), async (creds) => {
      const result = await narrate(FACTS, { creds });
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
    await withEnv(geminiEnv(mock), async (creds) => {
      const result = await narrate(FACTS, { creds });
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

test('asking for Gemini without a key explains itself instead of staying quiet', async () => {
  await withEnv({ LLM_PROVIDER: 'gemini' }, async (creds) => {
    assert.equal(llmConfigured(creds), false);

    const info = llmInfo(creds);
    assert.equal(info.enabled, false);
    assert.equal(info.provider, 'gemini');
    // Plain language and a place to get one. The old message named an environment
    // variable that no longer exists anywhere in this app.
    assert.match(info.problem, /no key/i);
    assert.match(info.problem, /aistudio\.google\.com/);
  });
});

test('an unrecognised LLM_PROVIDER is an error naming the two valid values', async () => {
  // Silently falling back would produce a guide that never gets narrated and a
  // config file that looks correct.
  await withEnv({ LLM_PROVIDER: 'anthropic' }, async (creds) => {
    const info = llmInfo(creds);
    assert.equal(info.enabled, false);
    assert.match(info.problem, /LLM_PROVIDER/);
    assert.match(info.problem, /gemini/);
    assert.match(info.problem, /openai/);

    const result = await narrate(FACTS, { creds });
    assert.equal(result.narrative, null);
    assert.match(result.meta.reason, /LLM_PROVIDER/);
  });
});

test('a complete LLM_ trio outranks a leftover Gemini key', async () => {
  // Three agreeing variables are a deliberate configuration; a single key may
  // just be left over from something else. LLM_PROVIDER settles it either way.
  await withEnv({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', GEMINI_API_KEY: 'g' }, async (creds) => {
    assert.equal(llmInfo(creds).provider, 'openai-compatible');
  });

  await withEnv(
    { LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm', GEMINI_API_KEY: 'g', LLM_PROVIDER: 'gemini' },
    async (creds) => {
      assert.equal(llmInfo(creds).provider, 'gemini');
    },
  );
});

test('LLM_MODEL names the model even on Gemini', async () => {
  const mock = await startGeminiMock();
  try {
    await withEnv(
      { GEMINI_API_KEY: 'k', GEMINI_BASE_URL: mock.base, LLM_MODEL: 'gemini-3.7-flash' },
      async (creds) => {
        await narrate(FACTS, { creds });
        assert.equal(mock.received[0].body.model, 'gemini-3.7-flash');
      },
    );
  } finally {
    await mock.close();
  }
});

test('an incomplete OpenAI-compatible trio does not half-enable the layer', async () => {
  await withEnv({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' }, async (creds) => {
    const info = llmInfo(creds);
    assert.equal(info.enabled, false);
    // Plain language now rather than variable names: the reader of this message is
    // looking at a form, not at a credential object.
    assert.match(info.problem, /base URL/);
    assert.match(info.problem, /model/);
  });
});

test('a preset supplies the base URL and a model, so a key alone is enough', async () => {
  // The whole point of presets. Someone who has never heard the phrase "base URL"
  // should be able to add free narration by pasting a key and picking a name.
  for (const preset of ['openrouter', 'groq', 'nvidia', 'cerebras']) {
    const resolved = resolveLlm({ LLM_PRESET: preset, LLM_API_KEY: 'k' });
    assert.equal(resolved.configured, true, `${preset} should configure from a key alone`);
    assert.equal(resolved.provider, 'openai-compatible');
    assert.ok(resolved.baseUrl.startsWith('https://'), `${preset} should carry an https base URL`);
    assert.ok(resolved.model.length > 0, `${preset} should carry a default model`);
    assert.equal(resolved.endpoint, `${resolved.baseUrl}/chat/completions`);
    // llmInfo is what the settings panel reads, so it has to agree.
    assert.equal(llmInfo({ LLM_PRESET: preset, LLM_API_KEY: 'k' }).enabled, true);
  }
});

test('a preset cannot half-configure: custom still needs a base URL', async () => {
  // `custom` is the one preset with no URL of its own, so it is the one that can
  // still arrive incomplete. It must not silently configure.
  const info = llmInfo({ LLM_PRESET: 'custom', LLM_API_KEY: 'k' });
  assert.equal(info.enabled, false);
  assert.match(info.problem, /base URL/);
});

test('a preset model can be overridden without losing the base URL', async () => {
  const resolved = resolveLlm({
    LLM_PRESET: 'openrouter',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'some/other-model:free',
  });
  assert.equal(resolved.configured, true);
  assert.equal(resolved.model, 'some/other-model:free');
  assert.equal(resolved.baseUrl, 'https://openrouter.ai/api/v1');
});

test('the gemini preset uses the Gemini transport, not the OpenAI one', async () => {
  // Picking Gemini by name must not produce a `/chat/completions` URL against
  // Google, which serves no such endpoint.
  const info = llmInfo({ LLM_PRESET: 'gemini', LLM_API_KEY: 'k' });
  assert.equal(info.enabled, true);
  assert.equal(info.provider, 'gemini');
  assert.match(info.endpoint, /generativelanguage\.googleapis\.com/);
  assert.match(info.endpoint, /\/interactions$/);
});

test('provider resolution is a pure function of its input', async () => {
  // resolveLlm takes the credentials as an argument, so resolution is checkable
  // with no global state at all. Nothing here mutates process.env, and nothing
  // could: the function has no way to reach it.
  assert.equal(resolveLlm({}).configured, false);
  assert.equal(resolveLlm({ GEMINI_API_KEY: 'k' }).provider, 'gemini');
  assert.equal(resolveLlm({ GEMINI_API_KEY: 'k' }).model, GEMINI_DEFAULT_MODEL);
  assert.equal(resolveLlm({ LLM_API_KEY: 'k', LLM_BASE_URL: 'http://x/v1/', LLM_MODEL: 'm' }).endpoint, 'http://x/v1/chat/completions');
  assert.equal(resolveLlm({ LLM_PROVIDER: 'nope' }).configured, false);
  assert.equal(resolveLlm({ GEMINI_BASE_URL: 'http://x/v1beta/' }).endpoint, undefined, 'no key means no endpoint');
});