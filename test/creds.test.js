/**
 * The credential contract.
 *
 * Two properties matter enough to test rather than trust: a header must never
 * reach a log or an error message, and one deployment must serve many callers at
 * once without one caller's key touching another's run. Everything else here is
 * shape, which is cheap to assert and expensive to get wrong by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readCreds, CRED_HEADER_LIST } from '../src/server/creds.js';

/** A request object shaped the way Node builds one, so nothing here is a fiction. */
function req(headers = {}) {
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
}

test('an absent credential is reported as absent, not as an empty one', () => {
  const creds = readCreds(req());
  assert.equal(creds.hasTinyfishKey, false);
  assert.equal(creds.tinyfishKey, '');
  assert.deepEqual(creds.llm, {});
});

test('the TinyFish key arrives in its header', () => {
  const creds = readCreds(req({ 'x-brandkit-tinyfish-key': 'sk-tinyfish-abc' }));
  assert.equal(creds.hasTinyfishKey, true);
  assert.equal(creds.tinyfishKey, 'sk-tinyfish-abc');
});

test('a bare LLM key means Gemini, so the one-field setup stays one field', () => {
  const creds = readCreds(req({ 'x-brandkit-llm-key': 'AIza...' }));
  assert.deepEqual(creds.llm, { GEMINI_API_KEY: 'AIza...' });
});

test('an OpenAI-compatible server carries its base URL and model', () => {
  const creds = readCreds(req({
    'x-brandkit-llm-provider': 'openai',
    'x-brandkit-llm-key': 'sk-openai',
    'x-brandkit-llm-base': 'https://api.example.com/v1/',
    'x-brandkit-llm-model': 'some-model',
  }));

  assert.deepEqual(creds.llm, {
    LLM_PROVIDER: 'openai-compatible',
    LLM_API_KEY: 'sk-openai',
    LLM_BASE_URL: 'https://api.example.com/v1/',
    LLM_MODEL: 'some-model',
  });
});

test('an incomplete OpenAI-compatible trio is passed through, not silently completed', () => {
  // resolveLlm already reports this state by name. Inventing a default base URL
  // here would give the same mistake two different messages, and send a real key
  // to wherever we guessed.
  const creds = readCreds(req({
    'x-brandkit-llm-provider': 'openai',
    'x-brandkit-llm-key': 'sk-openai',
  }));

  assert.deepEqual(creds.llm, { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-openai' });
});

test('an unknown provider reaches resolveLlm so it can be named', () => {
  const creds = readCreds(req({
    'x-brandkit-llm-provider': 'anthropic',
    'x-brandkit-llm-key': 'sk-x',
  }));

  assert.equal(creds.llm.LLM_PROVIDER, 'anthropic');
});

test('every credential header is advertised for CORS', () => {
  const names = CRED_HEADER_LIST.split(', ');
  for (const header of [
    'x-brandkit-tinyfish-key',
    'x-brandkit-llm-provider',
    'x-brandkit-llm-key',
    'x-brandkit-llm-base',
    'x-brandkit-llm-model',
  ]) {
    assert.ok(names.includes(header), `${header} is missing from the CORS allow-list`);
  }
});

test('a header cannot be used to park an unbounded payload', () => {
  const creds = readCreds(req({ 'x-brandkit-tinyfish-key': 'k'.repeat(5000) }));
  assert.equal(creds.tinyfishKey.length, 512);
});

test('surrounding whitespace is trimmed from every field', () => {
  const creds = readCreds(req({
    'x-brandkit-tinyfish-key': '  sk-abc  ',
    'x-brandkit-llm-key': '\tAIza\n',
  }));

  assert.equal(creds.tinyfishKey, 'sk-abc');
  assert.deepEqual(creds.llm, { GEMINI_API_KEY: 'AIza' });
});

test('two callers read two different sets of credentials', () => {
  const first = readCreds(req({ 'x-brandkit-tinyfish-key': 'sk-first' }));
  const second = readCreds(req({ 'x-brandkit-tinyfish-key': 'sk-second' }));

  assert.equal(first.tinyfishKey, 'sk-first');
  assert.equal(second.tinyfishKey, 'sk-second');
});

test('a missing request is an absent credential rather than a crash', () => {
  const creds = readCreds(undefined);
  assert.equal(creds.hasTinyfishKey, false);
  assert.deepEqual(creds.llm, {});
});

test('a key lands in exactly one field, never two', () => {
  // One place a secret is written is one place it can leak from, and it is the
  // duplication that is easy to introduce by accident: an LLM key stored as both
  // GEMINI_API_KEY and LLM_API_KEY would be sent to whichever provider the alias
  // table happens to pick.
  const creds = readCreds(req({
    'x-brandkit-tinyfish-key': 'sk-secret-value',
    'x-brandkit-llm-key': 'llm-secret-value',
    'x-brandkit-llm-provider': 'gemini',
  }));

  assert.equal(creds.tinyfishKey, 'sk-secret-value');
  assert.deepEqual(creds.llm, { GEMINI_API_KEY: 'llm-secret-value' });

  const occurrences = (needle) => JSON.stringify(creds).split(needle).length - 1;
  assert.equal(occurrences('llm-secret-value'), 1);
  assert.equal(occurrences('sk-secret-value'), 1);
});